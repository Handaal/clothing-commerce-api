const errors = {
  SUPPLIER_NOT_FOUND: [404, "The requested supplier does not exist."],
  SUPPLIER_INACTIVE: [409, "The supplier is inactive for new receipts."],
  SUPPLIER_CODE_CONFLICT: [409, "The supplier code is already in use."],
  INVALID_SUPPLIER: [422, "The supplier request is not valid."],
  IDEMPOTENCY_CONFLICT: [409, "The idempotency key was reused with a different payload."],
} as const;
export class SupplierError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "SupplierError";
    this.httpStatus = errors[code][0];
  }
}
export function supplierDatabaseError(error: { code?: string }) {
  switch (error.code) {
    case "SU404":
      return new SupplierError("SUPPLIER_NOT_FOUND");
    case "SU409":
      return new SupplierError("SUPPLIER_INACTIVE");
    case "ID409":
      return new SupplierError("IDEMPOTENCY_CONFLICT");
    case "23505":
      return new SupplierError("SUPPLIER_CODE_CONFLICT");
    case "22023":
    case "23514":
      return new SupplierError("INVALID_SUPPLIER");
    default:
      return new Error("An unexpected supplier persistence error occurred.");
  }
}
