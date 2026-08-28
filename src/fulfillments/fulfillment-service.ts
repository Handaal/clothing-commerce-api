import { z } from "zod";

import {
  executeAuthorizedOperation,
  type AuthorizationContext,
  type AuthorizationResource,
  type AuthorizationService,
  type AuthorizedOperationContext,
} from "../authorization";
import { mintFulfillmentExecutionProof } from "./execution-proof";
import { FulfillmentError } from "./errors";
import {
  CreateFulfillmentInputSchema,
  FulfillmentPermission,
  GetFulfillmentInputSchema,
  GetOrderFulfillmentSummaryInputSchema,
  GetOrderFulfillmentsInputSchema,
  type CreateFulfillmentInput,
  type FulfillmentClientIntent,
  type FulfillmentResult,
  type GetFulfillmentInput,
  type GetOrderFulfillmentSummaryInput,
  type GetOrderFulfillmentsInput,
  type OrderChannel,
  type OrderFulfillmentSummary,
} from "./model";
import type { FulfillmentRepository } from "./repository";

function brandResource(id: string): AuthorizationResource {
  return { kind: "brand", id };
}

function branchResource(id: string): AuthorizationResource {
  return { kind: "branch", id };
}

function locationResource(id: string): AuthorizationResource {
  return { kind: "inventory_location", id };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new FulfillmentError("INVALID_FULFILLMENT");
  }
  return parsed.data;
}

/**
 * Phase 2E fulfillment application service. It is the only place the rest of the commerce system creates
 * or reads a Fulfillment. Every command:
 *   - for a NEW create, authorizes BOTH the COMMERCIAL authority (orders.fulfill against the persisted
 *     Order's brand/branch) AND the CUSTODY authority (inventory.issue against the InventoryLocation),
 *     then mints a composite FulfillmentExecutionProof the repository requires for the mutation;
 *   - for an IDEMPOTENT REPLAY, authorizes BOTH authorities against the IMMUTABLE PERSISTED resources of
 *     the existing Fulfillment/Order and returns the original without re-resolving any current
 *     register/branch/brand/location/stock state (the database record_fulfillment short-circuits to the
 *     original and never issues a second time);
 *   - for READS, authorizes the COMMERCIAL READ authority (orders.read) only, with a proof whose
 *     provenance is deliberately distinct from the mutation composite proof;
 *   - derives the actor Membership from the verified context, never from caller input.
 * No raw persistence detail is ever exposed to callers.
 */
export class FulfillmentService {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly repository: FulfillmentRepository,
  ) {}

  async createFulfillment(
    context: AuthorizationContext,
    input: CreateFulfillmentInput,
  ): Promise<FulfillmentResult> {
    const command = parseInput(CreateFulfillmentInputSchema, input);
    const normalizedKey = command.idempotencyKey.trim().toLowerCase();
    const intent: FulfillmentClientIntent = {
      orderId: command.orderId,
      inventoryLocationId: command.inventoryLocationId,
      lines: command.lines.map((line) => ({
        orderLineId: line.orderLineId,
        quantity: line.quantity,
      })),
    };

    // Replay-safe preflight: runs after verified tenant context but BEFORE any business authorization or
    // order/location resolution.
    const preflight = await this.repository.resolveReplayTarget(
      context.tenant.id,
      normalizedKey,
      intent,
    );

    if (preflight.kind === "conflict") {
      throw new FulfillmentError("IDEMPOTENCY_CONFLICT");
    }

    if (preflight.kind === "replay") {
      // Authorize BOTH authorities against the PERSISTED resources of the existing Fulfillment/Order.
      // Register reassignment, catalog mutation, or Location deactivation after the original create
      // cannot affect this, and possession of the key does not bypass authorization.
      const commercialResource = this.commercialResourceFor(
        preflight.channel,
        preflight.brandId,
        preflight.branchId,
      );
      const proof = await this.mintExecutionProof(
        context,
        commercialResource,
        preflight.orderId,
        preflight.inventoryLocationId,
      );
      // The database fast-path returns the original ids and issues nothing further.
      await this.repository.recordFulfillment(proof, {
        tenantId: context.tenant.id,
        orderId: preflight.orderId,
        inventoryLocationId: preflight.inventoryLocationId,
        actorMembershipId: context.membership.id,
        idempotencyKey: command.idempotencyKey,
        lines: intent.lines,
      });
      return this.loadFulfillment(context, preflight.fulfillmentId, commercialResource);
    }

    // NEW command: resolve the Order's commercial routing to know the resource to authorize against.
    const routing = await this.repository.getOrderRouting(context.tenant.id, command.orderId);
    if (routing === null) {
      throw new FulfillmentError("ORDER_NOT_FOUND");
    }
    const commercialResource = this.commercialResourceFor(
      routing.channel,
      routing.brandId,
      routing.branchId,
    );
    const proof = await this.mintExecutionProof(
      context,
      commercialResource,
      command.orderId,
      command.inventoryLocationId,
    );
    const recorded = await this.repository.recordFulfillment(proof, {
      tenantId: context.tenant.id,
      orderId: command.orderId,
      inventoryLocationId: command.inventoryLocationId,
      actorMembershipId: context.membership.id,
      idempotencyKey: command.idempotencyKey,
      lines: intent.lines,
    });
    return this.loadFulfillment(context, recorded.fulfillmentId, commercialResource);
  }

  async getFulfillment(
    context: AuthorizationContext,
    input: GetFulfillmentInput,
  ): Promise<FulfillmentResult> {
    const command = parseInput(GetFulfillmentInputSchema, input);
    const routing = await this.repository.getFulfillmentRouting(
      context.tenant.id,
      command.fulfillmentId,
    );
    if (routing === null) {
      throw new FulfillmentError("FULFILLMENT_NOT_FOUND");
    }
    const commercialResource = this.commercialResourceFor(
      routing.channel,
      routing.brandId,
      routing.branchId,
    );
    return this.loadFulfillment(context, routing.fulfillmentId, commercialResource);
  }

  async getOrderFulfillments(
    context: AuthorizationContext,
    input: GetOrderFulfillmentsInput,
  ): Promise<readonly FulfillmentResult[]> {
    const command = parseInput(GetOrderFulfillmentsInputSchema, input);
    const routing = await this.repository.getOrderRouting(context.tenant.id, command.orderId);
    if (routing === null) {
      throw new FulfillmentError("ORDER_NOT_FOUND");
    }
    const commercialResource = this.commercialResourceFor(
      routing.channel,
      routing.brandId,
      routing.branchId,
    );
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: FulfillmentPermission.read, resources: [commercialResource] },
      operation: async (proof) =>
        this.repository.getOrderFulfillments(proof, context.tenant.id, routing.orderId),
    });
  }

  async getOrderFulfillmentSummary(
    context: AuthorizationContext,
    input: GetOrderFulfillmentSummaryInput,
  ): Promise<OrderFulfillmentSummary> {
    const command = parseInput(GetOrderFulfillmentSummaryInputSchema, input);
    const routing = await this.repository.getOrderRouting(context.tenant.id, command.orderId);
    if (routing === null) {
      throw new FulfillmentError("ORDER_NOT_FOUND");
    }
    const commercialResource = this.commercialResourceFor(
      routing.channel,
      routing.brandId,
      routing.branchId,
    );
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: FulfillmentPermission.read, resources: [commercialResource] },
      operation: async (proof) => {
        const summary = await this.repository.getOrderFulfillmentSummary(
          proof,
          context.tenant.id,
          routing.orderId,
        );
        if (summary === null) {
          throw new FulfillmentError("ORDER_NOT_FOUND");
        }
        return summary;
      },
    });
  }

  /**
   * Authorizes BOTH authorities and mints the composite proof. The commercial authority (orders.fulfill)
   * is checked against the Order's brand/branch; the custody authority (inventory.issue) against the
   * InventoryLocation. Either denial throws AuthorizationError before any mutation.
   */
  private async mintExecutionProof(
    context: AuthorizationContext,
    commercialResource: AuthorizationResource,
    orderId: string,
    inventoryLocationId: string,
  ) {
    const commercial = await this.authorizationService.authorize(context, {
      permissionKey: FulfillmentPermission.fulfill,
      resources: [commercialResource],
    });
    const custody = await this.authorizationService.authorize(context, {
      permissionKey: FulfillmentPermission.issue,
      resources: [locationResource(inventoryLocationId)],
    });
    return mintFulfillmentExecutionProof({
      commercial,
      custody,
      orderId,
      inventoryLocationId,
      commercialResource,
    });
  }

  private async loadFulfillment(
    context: AuthorizationContext,
    fulfillmentId: string,
    commercialResource: AuthorizationResource,
  ): Promise<FulfillmentResult> {
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: FulfillmentPermission.read, resources: [commercialResource] },
      operation: async (proof: AuthorizedOperationContext) => {
        const fulfillment = await this.repository.getFulfillment(
          proof,
          context.tenant.id,
          fulfillmentId,
        );
        if (fulfillment === null) {
          throw new FulfillmentError("FULFILLMENT_NOT_FOUND");
        }
        return fulfillment;
      },
    });
  }

  private commercialResourceFor(
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
}
