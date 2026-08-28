export { FulfillmentService } from "./fulfillment-service";
export {
  FulfillmentError,
  fulfillmentErrorCodes,
  fulfillmentErrorResponse,
  type FulfillmentErrorCode,
} from "./errors";
export {
  FulfillmentPermission,
  type CreateFulfillmentInput,
  type FulfillmentLineResult,
  type FulfillmentProgressStatus,
  type FulfillmentResult,
  type GetFulfillmentInput,
  type GetOrderFulfillmentSummaryInput,
  type GetOrderFulfillmentsInput,
  type OrderChannel,
  type OrderFulfillmentLineSummary,
  type OrderFulfillmentSummary,
} from "./model";
export {
  createSupabaseFulfillmentRepository,
  SupabaseFulfillmentRepository,
  type SupabaseFulfillmentRepositoryConfiguration,
} from "./supabase-fulfillment-repository";
export type { CreateFulfillmentCommand, FulfillmentRepository } from "./repository";
// The composite-proof TYPE and its provenance assertion are public (the repository boundary needs
// them); the MINT is intentionally NOT re-exported, so it stays reachable only from inside this module
// (the trusted FulfillmentService path) and ordinary callers can never fabricate the proof.
export { assertFulfillmentExecutionProof, type FulfillmentExecutionProof } from "./execution-proof";
