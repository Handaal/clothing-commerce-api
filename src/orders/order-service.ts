import { z } from "zod";

import {
  executeAuthorizedOperation,
  type AuthorizationContext,
  type AuthorizationResource,
  type AuthorizationService,
  type AuthorizedOperationContext,
} from "../authorization";
import { OrderError } from "./errors";
import {
  CancelOrderInputSchema,
  CreateOrderInputSchema,
  GetOrderByNumberInputSchema,
  GetOrderInputSchema,
  OrderChannel,
  OrderPermission,
  type CancelOrderInput,
  type CreateOrderInput,
  type GetOrderByNumberInput,
  type GetOrderInput,
  type OrderClientIntent,
  type OrderResult,
  type ResolvedOrderLine,
} from "./model";
import type { OrderRepository } from "./repository";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function brandResource(id: string): AuthorizationResource {
  return { kind: "brand", id };
}

function branchResource(id: string): AuthorizationResource {
  return { kind: "branch", id };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  // Malformed input at this internal boundary surfaces as a single stable, non-leaking error. A
  // future HTTP layer performs richer request-shape validation before reaching the service.
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new OrderError("INVALID_ORDER");
  }
  return parsed.data;
}

/**
 * Phase 2D order application service. It is the only place the rest of the commerce system creates,
 * reads, or cancels an Order. Every command:
 *   - authorizes a permission against the correct resource BEFORE any commercial order access;
 *   - for a NEW create, authorizes against CURRENT resources (POS: branch resolved from the register;
 *     ONLINE: brand derived from the requested variants);
 *   - for an IDEMPOTENT REPLAY, authorizes against the IMMUTABLE PERSISTED resources of the existing
 *     order and returns it without resolving any current catalog/price/register state;
 *   - derives the actor Membership from the verified context, never from caller input;
 *   - resolves authoritative prices/snapshots server-side (a caller never supplies price/brand/branch).
 * No raw persistence detail is ever exposed to callers.
 */
export class OrderService {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly repository: OrderRepository,
  ) {}

  async createOrder(context: AuthorizationContext, input: CreateOrderInput): Promise<OrderResult> {
    const command = parseInput(CreateOrderInputSchema, input);
    const normalizedKey = command.idempotencyKey.trim().toLowerCase();
    const intent: OrderClientIntent = {
      channel: command.channel,
      currency: command.currency,
      registerId: command.registerId ?? null,
      lines: command.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
    };

    // Replay-safe preflight: runs after verified tenant context but BEFORE any business authorization
    // or catalog/register resolution.
    const preflight = await this.repository.resolveIdempotentReplayTarget(
      context.tenant.id,
      normalizedKey,
      intent,
    );

    if (preflight.kind === "conflict") {
      throw new OrderError("IDEMPOTENCY_CONFLICT");
    }

    if (preflight.kind === "replay") {
      // Authorize against the PERSISTED resource of the existing order. Register reassignment or
      // catalog mutation after the original create cannot affect this, and possession of the key does
      // not bypass authorization.
      const resource = this.resourceFor(preflight.channel, preflight.brandId, preflight.branchId);
      return executeAuthorizedOperation({
        authorizationService: this.authorizationService,
        context,
        request: { permissionKey: OrderPermission.create, resources: [resource] },
        operation: async (proof) => this.loadOrder(proof, context.tenant.id, preflight.orderId),
      });
    }

    return command.channel === "pos"
      ? this.createPosOrder(context, command)
      : this.createOnlineOrder(context, command);
  }

  private async createPosOrder(
    context: AuthorizationContext,
    command: CreateOrderInput,
  ): Promise<OrderResult> {
    // registerId is guaranteed present for pos by the input schema.
    const registerId = command.registerId as string;

    // BOOTSTRAP: resolve the register's operational branch to know the resource to authorize against.
    const registerContext = await this.repository.getRegisterContext(context.tenant.id, registerId);
    if (registerContext === null) {
      throw new OrderError("REGISTER_NOT_FOUND");
    }
    const branchId = registerContext.branchId;

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: OrderPermission.create, resources: [branchResource(branchId)] },
      operation: async (proof) => {
        // NEW-command validation of CURRENT state (skipped on replay).
        if (registerContext.status !== "active") {
          throw new OrderError("REGISTER_INACTIVE");
        }
        const branchStatus = await this.repository.getBranchStatus(
          proof,
          context.tenant.id,
          branchId,
        );
        if (branchStatus === null) {
          throw new OrderError("BRANCH_NOT_FOUND");
        }
        if (branchStatus !== "active") {
          throw new OrderError("BRANCH_INACTIVE");
        }

        const { brandId, lines } = await this.resolveLines(
          proof,
          context.tenant.id,
          command.currency,
          command.lines,
        );

        const carried = await this.repository.isBrandCarriedByBranch(
          proof,
          context.tenant.id,
          branchId,
          brandId,
        );
        if (!carried) {
          throw new OrderError("BRAND_NOT_AVAILABLE_AT_BRANCH");
        }

        const orderId = await this.repository.createOrder(proof, {
          tenantId: context.tenant.id,
          channel: "pos",
          currency: command.currency,
          brandId,
          branchId,
          registerId,
          actorMembershipId: context.membership.id,
          idempotencyKey: command.idempotencyKey,
          notes: command.notes,
          lines,
        });

        return this.loadOrder(proof, context.tenant.id, orderId);
      },
    });
  }

  private async createOnlineOrder(
    context: AuthorizationContext,
    command: CreateOrderInput,
  ): Promise<OrderResult> {
    // BOOTSTRAP: derive the single Brand of the requested variants to know the resource to authorize
    // against. ONLINE has no branch.
    const variantIds = command.lines.map((line) => line.variantId);
    const derived = await this.repository.deriveBrandForVariants(context.tenant.id, variantIds);
    if (derived === null) {
      throw new OrderError("VARIANT_NOT_FOUND");
    }
    if ("crossBrand" in derived) {
      throw new OrderError("CROSS_BRAND_ORDER");
    }
    const brandId = derived.brandId;

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: OrderPermission.create, resources: [brandResource(brandId)] },
      operation: async (proof) => {
        const resolved = await this.resolveLines(
          proof,
          context.tenant.id,
          command.currency,
          command.lines,
        );
        if (resolved.brandId !== brandId) {
          // A concurrent catalog change between derivation and resolution; fail closed.
          throw new OrderError("CROSS_BRAND_ORDER");
        }

        const orderId = await this.repository.createOrder(proof, {
          tenantId: context.tenant.id,
          channel: "online",
          currency: command.currency,
          brandId,
          branchId: null,
          registerId: null,
          actorMembershipId: null,
          idempotencyKey: command.idempotencyKey,
          notes: command.notes,
          lines: resolved.lines,
        });

        return this.loadOrder(proof, context.tenant.id, orderId);
      },
    });
  }

  async getOrder(context: AuthorizationContext, input: GetOrderInput): Promise<OrderResult> {
    const command = parseInput(GetOrderInputSchema, input);
    const routing = await this.repository.getOrderRouting(context.tenant.id, command.orderId);
    if (routing === null) {
      throw new OrderError("ORDER_NOT_FOUND");
    }

    const resource = this.resourceFor(routing.channel, routing.brandId, routing.branchId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: OrderPermission.read, resources: [resource] },
      operation: async (proof) => this.loadOrder(proof, context.tenant.id, routing.orderId),
    });
  }

  async getOrderByNumber(
    context: AuthorizationContext,
    input: GetOrderByNumberInput,
  ): Promise<OrderResult> {
    const command = parseInput(GetOrderByNumberInputSchema, input);
    const normalized = command.orderNumber.trim().toLowerCase();
    const routing = await this.repository.getOrderRoutingByNumber(context.tenant.id, normalized);
    if (routing === null) {
      throw new OrderError("ORDER_NOT_FOUND");
    }

    const resource = this.resourceFor(routing.channel, routing.brandId, routing.branchId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: OrderPermission.read, resources: [resource] },
      operation: async (proof) => this.loadOrder(proof, context.tenant.id, routing.orderId),
    });
  }

  async cancelOrder(context: AuthorizationContext, input: CancelOrderInput): Promise<OrderResult> {
    const command = parseInput(CancelOrderInputSchema, input);
    const routing = await this.repository.getOrderRouting(context.tenant.id, command.orderId);
    if (routing === null) {
      throw new OrderError("ORDER_NOT_FOUND");
    }

    const resource = this.resourceFor(routing.channel, routing.brandId, routing.branchId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: OrderPermission.cancel, resources: [resource] },
      operation: async (proof) => {
        await this.repository.cancelOrder(proof, {
          tenantId: context.tenant.id,
          orderId: routing.orderId,
          cancelledByMembershipId: context.membership.id,
          reason: command.reason,
        });
        return this.loadOrder(proof, context.tenant.id, routing.orderId);
      },
    });
  }

  private resourceFor(
    channel: OrderChannel,
    brandId: string,
    branchId: string | null,
  ): AuthorizationResource {
    if (channel === "pos") {
      if (branchId === null) {
        // A pos order always carries a branch; a null here is a server invariant violation.
        throw new Error("pos order is missing its operational branch");
      }
      return branchResource(branchId);
    }
    return brandResource(brandId);
  }

  private async loadOrder(
    proof: AuthorizedOperationContext,
    tenantId: string,
    orderId: string,
  ): Promise<OrderResult> {
    const order = await this.repository.getOrder(proof, tenantId, orderId);
    if (order === null) {
      throw new OrderError("ORDER_NOT_FOUND");
    }
    return order;
  }

  /**
   * Resolves each requested line to its current catalog state, active price, and immutable snapshots,
   * enforcing the single-brand invariant and checked (BigInt) money ranges so a persisted order stays
   * readable as JS safe integers. Called only on the NEW-command path (never on replay).
   */
  private async resolveLines(
    proof: AuthorizedOperationContext,
    tenantId: string,
    currency: string,
    lines: CreateOrderInput["lines"],
  ): Promise<{ brandId: string; lines: ResolvedOrderLine[] }> {
    const resolved: ResolvedOrderLine[] = [];
    let brandId: string | null = null;
    let orderTotal = 0n;

    for (const line of lines) {
      const catalog = await this.repository.getOrderLineCatalogState(
        proof,
        tenantId,
        line.variantId,
      );
      if (catalog === null) {
        throw new OrderError("VARIANT_NOT_FOUND");
      }
      if (catalog.variantStatus !== "active") {
        throw new OrderError("VARIANT_INACTIVE");
      }
      if (brandId === null) {
        brandId = catalog.brandId;
      } else if (brandId !== catalog.brandId) {
        throw new OrderError("CROSS_BRAND_ORDER");
      }

      const unitPriceMinor = await this.repository.getActiveUnitPrice(
        proof,
        tenantId,
        line.variantId,
        currency,
      );
      if (unitPriceMinor === null) {
        throw new OrderError("PRICE_NOT_FOUND");
      }

      // Checked money arithmetic: BigInt multiply/sum, range-checked to JS safe integer before store.
      const lineTotal = BigInt(line.quantity) * BigInt(unitPriceMinor);
      if (lineTotal > BigInt(MAX_SAFE)) {
        throw new OrderError("AMOUNT_OUT_OF_RANGE");
      }
      orderTotal += lineTotal;
      if (orderTotal > BigInt(MAX_SAFE)) {
        throw new OrderError("AMOUNT_OUT_OF_RANGE");
      }

      resolved.push({
        variantId: catalog.variantId,
        productId: catalog.productId,
        quantity: line.quantity,
        unitPriceMinor,
        productName: catalog.productName,
        variantName: catalog.variantName,
        sku: catalog.sku,
        optionSummary: catalog.optionSummary,
      });
    }

    if (brandId === null) {
      // Unreachable: the input schema requires at least one line.
      throw new OrderError("INVALID_ORDER");
    }
    return { brandId, lines: resolved };
  }
}
