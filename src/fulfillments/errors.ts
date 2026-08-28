/**
 * Stable fulfillment application errors. Authorization failures are represented by AuthorizationError
 * (from src/authorization) and are never duplicated here; a failed composite-proof provenance check is
 * also an AuthorizationError. Raw PostgreSQL SQLSTATEs and database messages must never escape the
 * repository; they are mapped to these codes. Unexpected/invariant failures (including a privilege
 * failure from a defect) surface as a generic Error, not a FulfillmentError.
 */
export const fulfillmentErrorCodes = [
  "FULFILLMENT_NOT_FOUND",
  "ORDER_NOT_FOUND",
  "ORDER_CANCELLED",
  "ORDER_LINE_NOT_FOUND",
  "ORDER_LINE_MISMATCH",
  "INVALID_QUANTITY",
  "INVALID_FULFILLMENT",
  "OVER_FULFILLMENT",
  "LOCATION_NOT_FOUND",
  "LOCATION_INACTIVE",
  "LOCATION_CAPABILITY_DENIED",
  "INSUFFICIENT_STOCK",
  "IDEMPOTENCY_CONFLICT",
  "TENANT_MISMATCH",
  "AMOUNT_OUT_OF_RANGE",
] as const;

export type FulfillmentErrorCode = (typeof fulfillmentErrorCodes)[number];

const safeMessages: Record<FulfillmentErrorCode, string> = {
  FULFILLMENT_NOT_FOUND: "The requested fulfillment does not exist.",
  ORDER_NOT_FOUND: "The requested order does not exist.",
  ORDER_CANCELLED: "The order is cancelled and cannot be fulfilled.",
  ORDER_LINE_NOT_FOUND: "A requested order line does not exist in this order.",
  ORDER_LINE_MISMATCH: "A requested line does not belong to this order.",
  INVALID_QUANTITY: "A requested quantity is not valid.",
  INVALID_FULFILLMENT: "The fulfillment request is not valid.",
  OVER_FULFILLMENT: "A requested quantity exceeds the unfulfilled remainder of the order line.",
  LOCATION_NOT_FOUND: "The requested inventory location does not exist.",
  LOCATION_INACTIVE: "The inventory location is not active.",
  LOCATION_CAPABILITY_DENIED: "The inventory location is not enabled for fulfillment.",
  INSUFFICIENT_STOCK: "There is not enough stock at the location to fulfill the request.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was reused with a different fulfillment intent.",
  TENANT_MISMATCH: "The requested resource does not exist.",
  AMOUNT_OUT_OF_RANGE: "A fulfillment quantity is outside the supported range.",
};

const httpStatusByCode: Record<FulfillmentErrorCode, 404 | 409 | 422> = {
  FULFILLMENT_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  ORDER_CANCELLED: 409,
  ORDER_LINE_NOT_FOUND: 404,
  ORDER_LINE_MISMATCH: 409,
  INVALID_QUANTITY: 422,
  INVALID_FULFILLMENT: 422,
  OVER_FULFILLMENT: 409,
  LOCATION_NOT_FOUND: 404,
  LOCATION_INACTIVE: 409,
  LOCATION_CAPABILITY_DENIED: 409,
  INSUFFICIENT_STOCK: 409,
  IDEMPOTENCY_CONFLICT: 409,
  TENANT_MISMATCH: 404,
  AMOUNT_OUT_OF_RANGE: 422,
};

export class FulfillmentError extends Error {
  readonly httpStatus: 404 | 409 | 422;

  constructor(readonly code: FulfillmentErrorCode) {
    super(safeMessages[code]);
    this.name = "FulfillmentError";
    this.httpStatus = httpStatusByCode[code];
  }
}

export function fulfillmentErrorResponse(error: FulfillmentError) {
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
