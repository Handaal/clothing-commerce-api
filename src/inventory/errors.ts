/**
 * Stable inventory application errors. Authorization failures are represented by AuthorizationError
 * (from src/authorization) and are never duplicated here. Raw PostgreSQL SQLSTATEs and database
 * messages must never escape the repository; they are mapped to these codes.
 */
export const inventoryErrorCodes = [
  "VARIANT_NOT_FOUND",
  "LOCATION_NOT_FOUND",
  "VARIANT_INACTIVE",
  "LOCATION_INACTIVE",
  "LOCATION_CAPABILITY_DENIED",
  "INVALID_QUANTITY",
  "INSUFFICIENT_STOCK",
  "OPENING_STOCK_ALREADY_EXISTS",
  "SAME_TRANSFER_LOCATION",
  "IDEMPOTENCY_CONFLICT",
  "CONCURRENT_MODIFICATION",
  "TENANT_MISMATCH",
] as const;

export type InventoryErrorCode = (typeof inventoryErrorCodes)[number];

const safeMessages: Record<InventoryErrorCode, string> = {
  VARIANT_NOT_FOUND: "The requested variant does not exist.",
  LOCATION_NOT_FOUND: "The requested inventory location does not exist.",
  VARIANT_INACTIVE: "The variant is not active for this operation.",
  LOCATION_INACTIVE: "The inventory location is not active for this operation.",
  LOCATION_CAPABILITY_DENIED: "The inventory location does not permit this operation.",
  INVALID_QUANTITY: "The requested quantity is not valid.",
  INSUFFICIENT_STOCK: "There is not enough stock on hand for this operation.",
  OPENING_STOCK_ALREADY_EXISTS: "Opening stock already exists for this variant and location.",
  SAME_TRANSFER_LOCATION: "A transfer source and destination must be different locations.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was reused with a different payload.",
  CONCURRENT_MODIFICATION: "The inventory balance changed since it was read; refresh and retry.",
  TENANT_MISMATCH: "The requested resource does not exist.",
};

const httpStatusByCode: Record<InventoryErrorCode, 404 | 409 | 422> = {
  VARIANT_NOT_FOUND: 404,
  LOCATION_NOT_FOUND: 404,
  VARIANT_INACTIVE: 409,
  LOCATION_INACTIVE: 409,
  LOCATION_CAPABILITY_DENIED: 409,
  INVALID_QUANTITY: 422,
  INSUFFICIENT_STOCK: 409,
  OPENING_STOCK_ALREADY_EXISTS: 409,
  SAME_TRANSFER_LOCATION: 422,
  IDEMPOTENCY_CONFLICT: 409,
  CONCURRENT_MODIFICATION: 409,
  TENANT_MISMATCH: 404,
};

export class InventoryError extends Error {
  readonly httpStatus: 404 | 409 | 422;

  constructor(readonly code: InventoryErrorCode) {
    super(safeMessages[code]);
    this.name = "InventoryError";
    this.httpStatus = httpStatusByCode[code];
  }
}

export function inventoryErrorResponse(error: InventoryError) {
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
