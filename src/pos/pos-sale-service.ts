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
import type { PosQuoteResponse } from "../contracts/pos";
import {
  CreatePosSaleInputSchema,
  PosPermission,
  type CreatePosSaleInput,
  type PosContextResult,
  type PosQuoteInput,
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
        branch: candidate.branch,
      });
    }
    // Server-owned business identity for receipt rendering (never a receipt template).
    const tenant = await this.repository.getBusinessIdentity(context.tenant.id);
    return { business: { tenant }, registers };
  }

  async createSale(
    context: AuthorizationContext,
    input: CreatePosSaleInput,
    idempotencyKey: string,
  ): Promise<PosSaleResult> {
    const parsed = CreatePosSaleInputSchema.safeParse(input);
    if (!parsed.success) throw new PosSaleError("INVALID_POS_SALE");
    const command = parsed.data;
    const promotionCode = command.promotionCode ?? null;
    const intent: PosSaleIntent = {
      registerId: command.registerId,
      expectedTotalMinor: command.expectedTotalMinor,
      cashReceivedMinor: command.cashReceivedMinor ?? null,
      tenders: command.tenders ?? null,
      amountPaidMinor: command.amountPaidMinor ?? null,
      promotionCode,
      customer: command.customer ?? null,
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

    const lines = await this.resolveLines(
      commercialProof,
      context.tenant.id,
      register,
      command.lines,
    );
    // With a promotion the expected total is the NET; the server (record_sale) is authoritative and
    // re-derives/validates it. Only the plain (no-promotion) path can be short-circuited client-locally.
    if (promotionCode === null) {
      const total = this.total(lines);
      if (total !== command.expectedTotalMinor) throw new PosSaleError("PRICE_CHANGED", total);
      // For a cash-only sale the handed amount must cover what is due now: the full total, or the
      // deposit for an installment sale. Split tenders are validated server-side.
      const dueNow = command.amountPaidMinor ?? total;
      if (command.tenders === undefined && (command.cashReceivedMinor ?? 0) < dueNow)
        throw new PosSaleError("CASH_RECEIVED_INSUFFICIENT");
    }

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
      cashReceivedMinor: command.cashReceivedMinor ?? null,
      tenders: command.tenders ?? null,
      amountPaidMinor: command.amountPaidMinor ?? null,
      promotionCode,
      customer: command.customer ?? null,
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

  async quote(context: AuthorizationContext, input: PosQuoteInput): Promise<PosQuoteResponse> {
    const register = await this.repository.getRegisterContext(context.tenant.id, input.registerId);
    if (register === null) throw new PosSaleError("REGISTER_NOT_FOUND");
    this.assertOperational(register);
    const proofs = await this.authorizeSale(context, register);
    const commercialProof = proofs.find((p) => p.permissionKey === PosPermission.createOrder);
    if (!commercialProof) throw new AuthorizationError("PERMISSION_DENIED");
    const lines = await this.resolveLines(
      commercialProof,
      context.tenant.id,
      register,
      input.lines,
    );
    const brandId = lines[0]?.brandId;
    if (!brandId) throw new PosSaleError("INVALID_POS_SALE");
    const gross = this.total(lines);
    const evaluation = await this.repository.evaluatePromotion({
      tenantId: context.tenant.id,
      currency: register.sellingCurrency,
      brandId,
      branchId: register.branchId,
      promotionCode: input.promotionCode,
      lines: lines.map((line) => ({
        variantId: line.variantId,
        productId: line.productId,
        quantity: line.quantity,
        lineTotalMinor: line.quantity * line.unitPriceMinor,
      })),
    });
    return {
      currency: register.sellingCurrency,
      grossSubtotalMinor: gross,
      discountTotalMinor: evaluation.discountTotalMinor,
      totalMinor: gross - evaluation.discountTotalMinor,
      codeStatus: evaluation.codeStatus,
      promotion: evaluation.promotion,
    };
  }

  private async resolveLines(
    proof: AuthorizedOperationContext,
    tenantId: string,
    register: PosRegisterContext,
    requestedLines: readonly { readonly variantId: string; readonly quantity: number }[],
  ): Promise<readonly ResolvedPosSaleLine[]> {
    let brandId: string | null = null;
    const result: ResolvedPosSaleLine[] = [];
    for (const requested of requestedLines) {
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
