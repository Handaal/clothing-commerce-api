import type { PosSaleExecutionProof } from "./execution-proof";
import type {
  PosBusinessIdentity,
  PosCustomerInput,
  PosRegisterContext,
  PosSaleIntent,
  PosSaleReplayTarget,
  PosSaleResult,
  PosTenderInput,
  ResolvedPosSaleLine,
} from "./model";

export interface RecordPosSaleCommand {
  readonly tenantId: string;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly registerId: string;
  readonly branchId: string;
  readonly inventoryLocationId: string;
  readonly currency: string;
  readonly brandId: string;
  readonly expectedTotalMinor: number;
  readonly cashReceivedMinor: number | null;
  readonly tenders: readonly PosTenderInput[] | null;
  readonly amountPaidMinor: number | null;
  readonly lines: readonly ResolvedPosSaleLine[];
  readonly promotionCode: string | null;
  readonly customer: PosCustomerInput | null;
}

export interface PromotionEvaluationInput {
  readonly tenantId: string;
  readonly currency: string;
  readonly brandId: string;
  readonly branchId: string;
  readonly promotionCode: string | null;
  readonly lines: readonly {
    readonly variantId: string;
    readonly productId: string;
    readonly quantity: number;
    readonly lineTotalMinor: number;
  }[];
}

export interface PosSaleRepository {
  resolveReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: PosSaleIntent,
  ): Promise<PosSaleReplayTarget>;
  listRegisterContexts(tenantId: string): Promise<readonly PosRegisterContext[]>;
  getBusinessIdentity(tenantId: string): Promise<PosBusinessIdentity>;
  getRegisterContext(tenantId: string, registerId: string): Promise<PosRegisterContext | null>;
  recordSale(proof: PosSaleExecutionProof, command: RecordPosSaleCommand): Promise<string>;
  getSale(
    proof: PosSaleExecutionProof,
    tenantId: string,
    saleId: string,
  ): Promise<PosSaleResult | null>;
  evaluatePromotion(input: PromotionEvaluationInput): Promise<{
    applied: boolean;
    discountTotalMinor: number;
    codeStatus: "none" | "valid" | "invalid";
    promotion: {
      promotionId: string;
      name: string;
      benefitType: "percentage" | "fixed_amount";
      activation: "automatic" | "code";
      code: string | null;
      discountTotalMinor: number;
    } | null;
  }>;
}
