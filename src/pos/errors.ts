export type PosSaleErrorCode =
  | "INVALID_POS_SALE"
  | "REGISTER_NOT_FOUND"
  | "REGISTER_INACTIVE"
  | "BRANCH_INACTIVE"
  | "LOCATION_INACTIVE"
  | "LOCATION_CAPABILITY_DENIED"
  | "VARIANT_NOT_FOUND"
  | "VARIANT_INACTIVE"
  | "PRICE_NOT_FOUND"
  | "CROSS_BRAND_ORDER"
  | "BRAND_NOT_AVAILABLE_AT_BRANCH"
  | "CASH_RECEIVED_INSUFFICIENT"
  | "PRICE_CHANGED"
  | "INSUFFICIENT_STOCK"
  | "IDEMPOTENCY_CONFLICT"
  | "TENANT_MISMATCH"
  | "AMOUNT_OUT_OF_RANGE";

const messages: Record<PosSaleErrorCode, string> = {
  INVALID_POS_SALE: "The POS sale request is not valid.",
  REGISTER_NOT_FOUND: "The requested register does not exist.",
  REGISTER_INACTIVE: "The register is not active for selling.",
  BRANCH_INACTIVE: "The register's branch is not active for selling.",
  LOCATION_INACTIVE: "The register's inventory location is not active.",
  LOCATION_CAPABILITY_DENIED: "The register's inventory location is not enabled for fulfillment.",
  VARIANT_NOT_FOUND: "A requested variant does not exist.",
  VARIANT_INACTIVE: "A requested variant is not available for sale.",
  PRICE_NOT_FOUND: "A requested variant has no active price in the register currency.",
  CROSS_BRAND_ORDER: "All sale lines must belong to one brand.",
  BRAND_NOT_AVAILABLE_AT_BRANCH: "The branch does not operate the sale's brand.",
  CASH_RECEIVED_INSUFFICIENT: "Cash received must cover the authoritative order total.",
  PRICE_CHANGED: "The authoritative sale total has changed.",
  INSUFFICIENT_STOCK: "There is not enough stock to complete the sale.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was reused with a different sale intent.",
  TENANT_MISMATCH: "The requested resource does not exist.",
  AMOUNT_OUT_OF_RANGE: "A sale amount is outside the supported range.",
};

const statuses: Record<PosSaleErrorCode, 404 | 409 | 422> = {
  INVALID_POS_SALE: 422,
  REGISTER_NOT_FOUND: 404,
  REGISTER_INACTIVE: 409,
  BRANCH_INACTIVE: 409,
  LOCATION_INACTIVE: 409,
  LOCATION_CAPABILITY_DENIED: 409,
  VARIANT_NOT_FOUND: 404,
  VARIANT_INACTIVE: 409,
  PRICE_NOT_FOUND: 409,
  CROSS_BRAND_ORDER: 422,
  BRAND_NOT_AVAILABLE_AT_BRANCH: 409,
  CASH_RECEIVED_INSUFFICIENT: 422,
  PRICE_CHANGED: 409,
  INSUFFICIENT_STOCK: 409,
  IDEMPOTENCY_CONFLICT: 409,
  TENANT_MISMATCH: 404,
  AMOUNT_OUT_OF_RANGE: 422,
};

export class PosSaleError extends Error {
  readonly httpStatus: 404 | 409 | 422;

  constructor(
    readonly code: PosSaleErrorCode,
    readonly authoritativeTotalMinor?: number,
  ) {
    super(messages[code]);
    this.name = "PosSaleError";
    this.httpStatus = statuses[code];
  }
}
