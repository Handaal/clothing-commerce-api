import { AuthorizationError } from "../authorization/errors";
import type {
  AuthorizationContext,
  AuthorizationResource,
  AuthorizationService,
  AuthorizedOperationContext,
} from "../authorization";
import type { OrderRepository } from "../orders/repository";
import { mintPosSaleExecutionProof } from "./execution-proof";
import { PosSaleError } from "./errors";
import {
  CreatePosSaleInputSchema,
  PosPermission,
  type CreatePosSaleInput,
  type PosContextResult,
  type PosRegisterContext,
  type PosSaleIntent,
  type PosSaleResult,
  type ResolvedPosSaleLine,
} from "./model";
import type { PosSaleRepository } from "./repository";

function branch(id: string): AuthorizationResource {
  return { kind: "branch", id };
}

function location(id: string): AuthorizationResource {
  return { kind: "inventory_location", id };
}

export class PosSaleService {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly repository: PosSaleRepository,
    private readonly orderRepository: OrderRepository,
  ) {}

  async getContext(context: AuthorizationContext): Promise<PosContextResult> {
    const candidates = await this.repository.listRegisterContexts(context.tenant.id);
    const registers: PosContextResult["registers"][number][] = [];
    for (const candidate of candidates) {
      if (!this.isOperational(candidate)) continue;
      try {
        await this.authorizeSale(context, candidate);
      } catch (error) {
        if (error instanceof AuthorizationError) continue;
        throw error;
      }
      registers.push({
        registerId: candidate.registerId,
        registerName: candidate.registerName,
        branchId: candidate.branchId,
        branchName: candidate.branchName,
        defaultInventoryLocationId: candidate.inventoryLocationId,
        defaultInventoryLocationName: candidate.inventoryLocationName,
        sellingCurrency: candidate.sellingCurrency,
        canSell: true,
      });
    }
    return { registers };
  }

  async createSale(
    context: AuthorizationContext,
    input: CreatePosSaleInput,
    idempotencyKey: string,
  ): Promise<PosSaleResult> {
    const parsed = CreatePosSaleInputSchema.safeParse(input);
    if (!parsed.success) throw new PosSaleError("INVALID_POS_SALE");
    const command = parsed.data;
    const intent: PosSaleIntent = {
      registerId: command.registerId,
      expectedTotalMinor: command.expectedTotalMinor,
      cashReceivedMinor: command.cashReceivedMinor,
      lines: command.lines.map((line) => ({ ...line })),
    };

    const replay = await this.repository.resolveReplayTarget(
      context.tenant.id,
      idempotencyKey.trim().toLowerCase(),
      intent,
    );
    if (replay.kind === "conflict") {
      await this.authorizeResources(context, replay.branchId, replay.inventoryLocationId);
      throw new PosSaleError("IDEMPOTENCY_CONFLICT");
    }
    if (replay.kind === "replay") {
      const proofs = await this.authorizeResources(
        context,
        replay.branchId,
        replay.inventoryLocationId,
      );
      const executionProof = mintPosSaleExecutionProof({
        proofs,
        branchId: replay.branchId,
        inventoryLocationId: replay.inventoryLocationId,
      });
      const sale = await this.repository.getSale(executionProof, context.tenant.id, replay.saleId);
      if (sale === null) throw new Error("A replay target did not resolve to a POS sale.");
      return sale;
    }

    const register = await this.repository.getRegisterContext(
      context.tenant.id,
      command.registerId,
    );
    if (register === null) throw new PosSaleError("REGISTER_NOT_FOUND");
    this.assertOperational(register);

    // Every authority, including orders.read for the response, is resolved before any mutation.
    const proofs = await this.authorizeSale(context, register);
    const commercialProof = proofs.find(
      (proof) => proof.permissionKey === PosPermission.createOrder,
    );
    if (!commercialProof) throw new AuthorizationError("PERMISSION_DENIED");

    const lines = await this.resolveLines(commercialProof, context.tenant.id, register, command);
    const total = this.total(lines);
    if (total !== command.expectedTotalMinor) throw new PosSaleError("PRICE_CHANGED", total);
    if (command.cashReceivedMinor < total) throw new PosSaleError("CASH_RECEIVED_INSUFFICIENT");

    const brandId = lines[0]?.brandId;
    if (!brandId) throw new PosSaleError("INVALID_POS_SALE");
    const executionProof = mintPosSaleExecutionProof({
      proofs,
      branchId: register.branchId,
      inventoryLocationId: register.inventoryLocationId,
    });
    const saleId = await this.repository.recordSale(executionProof, {
      tenantId: context.tenant.id,
      actorMembershipId: context.membership.id,
      idempotencyKey,
      registerId: register.registerId,
      branchId: register.branchId,
      inventoryLocationId: register.inventoryLocationId,
      currency: register.sellingCurrency,
      brandId,
      expectedTotalMinor: command.expectedTotalMinor,
      cashReceivedMinor: command.cashReceivedMinor,
      lines,
    });
    const sale = await this.repository.getSale(executionProof, context.tenant.id, saleId);
    if (sale === null) throw new Error("The committed POS sale could not be loaded.");
    return sale;
  }

  private isOperational(register: PosRegisterContext): boolean {
    return (
      register.registerStatus === "active" &&
      register.branchStatus === "active" &&
      register.inventoryLocationStatus === "active" &&
      register.fulfillmentEnabled
    );
  }

  private assertOperational(register: PosRegisterContext): void {
    if (register.registerStatus !== "active") throw new PosSaleError("REGISTER_INACTIVE");
    if (register.branchStatus !== "active") throw new PosSaleError("BRANCH_INACTIVE");
    if (register.inventoryLocationStatus !== "active") throw new PosSaleError("LOCATION_INACTIVE");
    if (!register.fulfillmentEnabled) throw new PosSaleError("LOCATION_CAPABILITY_DENIED");
  }

  private authorizeSale(
    context: AuthorizationContext,
    register: PosRegisterContext,
  ): Promise<readonly AuthorizedOperationContext[]> {
    return this.authorizeResources(context, register.branchId, register.inventoryLocationId);
  }

  private authorizeResources(
    context: AuthorizationContext,
    branchId: string,
    inventoryLocationId: string,
  ): Promise<readonly AuthorizedOperationContext[]> {
    return Promise.all([
      this.authorizationService.authorize(context, {
        permissionKey: PosPermission.createOrder,
        resources: [branch(branchId)],
      }),
      this.authorizationService.authorize(context, {
        permissionKey: PosPermission.fulfillOrder,
        resources: [branch(branchId)],
      }),
      this.authorizationService.authorize(context, {
        permissionKey: PosPermission.readOrder,
        resources: [branch(branchId)],
      }),
      this.authorizationService.authorize(context, {
        permissionKey: PosPermission.capturePayment,
        resources: [branch(branchId)],
      }),
      this.authorizationService.authorize(context, {
        permissionKey: PosPermission.issueInventory,
        resources: [location(inventoryLocationId)],
      }),
    ]);
  }

  private async resolveLines(
    proof: AuthorizedOperationContext,
    tenantId: string,
    register: PosRegisterContext,
    command: CreatePosSaleInput,
  ): Promise<readonly ResolvedPosSaleLine[]> {
    let brandId: string | null = null;
    const result: ResolvedPosSaleLine[] = [];
    for (const requested of command.lines) {
      const catalog = await this.orderRepository.getOrderLineCatalogState(
        proof,
        tenantId,
        requested.variantId,
      );
      if (!catalog) throw new PosSaleError("VARIANT_NOT_FOUND");
      if (catalog.variantStatus !== "active") throw new PosSaleError("VARIANT_INACTIVE");
      if (brandId !== null && brandId !== catalog.brandId) {
        throw new PosSaleError("CROSS_BRAND_ORDER");
      }
      brandId = catalog.brandId;
      const price = await this.orderRepository.getActiveUnitPrice(
        proof,
        tenantId,
        requested.variantId,
        register.sellingCurrency,
      );
      if (price === null) throw new PosSaleError("PRICE_NOT_FOUND");
      result.push({
        variantId: catalog.variantId,
        productId: catalog.productId,
        brandId: catalog.brandId,
        quantity: requested.quantity,
        unitPriceMinor: price,
        productName: catalog.productName,
        variantName: catalog.variantName,
        sku: catalog.sku,
        optionSummary: catalog.optionSummary,
      });
    }
    if (brandId === null) throw new PosSaleError("INVALID_POS_SALE");
    const carried = await this.orderRepository.isBrandCarriedByBranch(
      proof,
      tenantId,
      register.branchId,
      brandId,
    );
    if (!carried) throw new PosSaleError("BRAND_NOT_AVAILABLE_AT_BRANCH");
    return result;
  }

  private total(lines: readonly ResolvedPosSaleLine[]): number {
    let total = 0n;
    for (const line of lines) {
      total += BigInt(line.quantity) * BigInt(line.unitPriceMinor);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new PosSaleError("AMOUNT_OUT_OF_RANGE");
    }
    return Number(total);
  }
}
