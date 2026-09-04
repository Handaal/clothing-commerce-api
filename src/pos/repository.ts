import type { PosSaleExecutionProof } from "./execution-proof";
import type {
  PosRegisterContext,
  PosSaleIntent,
  PosSaleReplayTarget,
  PosSaleResult,
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
  readonly cashReceivedMinor: number;
  readonly lines: readonly ResolvedPosSaleLine[];
}

export interface PosSaleRepository {
  resolveReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: PosSaleIntent,
  ): Promise<PosSaleReplayTarget>;
  listRegisterContexts(tenantId: string): Promise<readonly PosRegisterContext[]>;
  getRegisterContext(tenantId: string, registerId: string): Promise<PosRegisterContext | null>;
  recordSale(proof: PosSaleExecutionProof, command: RecordPosSaleCommand): Promise<string>;
  getSale(
    proof: PosSaleExecutionProof,
    tenantId: string,
    saleId: string,
  ): Promise<PosSaleResult | null>;
}
