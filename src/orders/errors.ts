/**
 * Stable order application errors. Authorization failures are represented by AuthorizationError (from
 * src/authorization) and are never duplicated here. Raw PostgreSQL SQLSTATEs and database messages
 * must never escape the repository; they are mapped to these codes. Unexpected/invariant failures
 * (including money out-of-range from a defect) surface as a generic Error, not an OrderError.
 */
export const orderErrorCodes = [
  "ORDER_NOT_FOUND",
  "ORDER_ALREADY_FULFILLED",
  "REGISTER_NOT_FOUND",
  "REGISTER_INACTIVE",
  "BRANCH_NOT_FOUND",
  "BRANCH_INACTIVE",
  "BRAND_NOT_AVAILABLE_AT_BRANCH",
  "VARIANT_NOT_FOUND",
  "VARIANT_INACTIVE",
  "PRICE_NOT_FOUND",
  "CURRENCY_MISMATCH",
  "INVALID_QUANTITY",
  "INVALID_ORDER",
  "CROSS_BRAND_ORDER",
  "IDEMPOTENCY_CONFLICT",
  "TENANT_MISMATCH",
  "AMOUNT_OUT_OF_RANGE",
] as const;

export type OrderErrorCode = (typeof orderErrorCodes)[number];

const safeMessages: Record<OrderErrorCode, string> = {
  ORDER_NOT_FOUND: "The requested order does not exist.",
  ORDER_ALREADY_FULFILLED:
    "The order has already been fulfilled in whole or in part and cannot be cancelled.",
  REGISTER_NOT_FOUND: "The requested register does not exist.",
  REGISTER_INACTIVE: "The register is not active for this operation.",
  BRANCH_NOT_FOUND: "The requested branch does not exist.",
  BRANCH_INACTIVE: "The branch is not active for this operation.",
  BRAND_NOT_AVAILABLE_AT_BRANCH: "The branch does not operate the order's brand.",
  VARIANT_NOT_FOUND: "A requested variant does not exist.",
  VARIANT_INACTIVE: "A requested variant is not available for sale.",
  PRICE_NOT_FOUND: "A requested variant has no active price in the order currency.",
  CURRENCY_MISMATCH: "The requested currency is not valid for this order.",
  INVALID_QUANTITY: "A requested quantity is not valid.",
  INVALID_ORDER: "The order request is not valid.",
  CROSS_BRAND_ORDER: "All order lines must belong to a single brand.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was reused with a different order intent.",
  TENANT_MISMATCH: "The requested resource does not exist.",
  AMOUNT_OUT_OF_RANGE: "An order amount is outside the supported range.",
};

const httpStatusByCode: Record<OrderErrorCode, 404 | 409 | 422> = {
  ORDER_NOT_FOUND: 404,
  ORDER_ALREADY_FULFILLED: 409,
  REGISTER_NOT_FOUND: 404,
  REGISTER_INACTIVE: 409,
  BRANCH_NOT_FOUND: 404,
  BRANCH_INACTIVE: 409,
  BRAND_NOT_AVAILABLE_AT_BRANCH: 409,
  VARIANT_NOT_FOUND: 404,
  VARIANT_INACTIVE: 409,
  PRICE_NOT_FOUND: 409,
  CURRENCY_MISMATCH: 422,
  INVALID_QUANTITY: 422,
  INVALID_ORDER: 422,
  CROSS_BRAND_ORDER: 422,
  IDEMPOTENCY_CONFLICT: 409,
  TENANT_MISMATCH: 404,
  AMOUNT_OUT_OF_RANGE: 422,
};

export class OrderError extends Error {
  readonly httpStatus: 404 | 409 | 422;

  constructor(readonly code: OrderErrorCode) {
    super(safeMessages[code]);
    this.name = "OrderError";
    this.httpStatus = httpStatusByCode[code];
  }
}

export function orderErrorResponse(error: OrderError) {
  return {
    status: error.httpStatus,
    body: {
      error: {
        code: error.code,
        message: error.message,
      },
    },
  } as const;
}
