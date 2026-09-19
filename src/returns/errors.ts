const errors = {
  RETURN_NOT_FOUND: [404, "The return or original order was not found."],
  INVALID_RETURN: [400, "The return intent is invalid."],
  ORDER_LINE_MISMATCH: [422, "A return line does not belong to the original order."],
  RETURN_QUANTITY_EXCEEDED: [
    409,
    "The quantity exceeds the fulfilled quantity still eligible for return.",
  ],
  REFUND_CONFLICT: [
    409,
    "The refund conflicts with the remaining paid amount or settlement state.",
  ],
  RESTOCK_LOCATION_UNAVAILABLE: [422, "The restock location is unavailable."],
  RETURNS_DISABLED: [422, "Returns are not enabled by tenant policy."],
  ORDER_NOT_RETURNABLE: [422, "This order cannot be returned."],
  PAYMENT_NOT_CAPTURED: [422, "A return with refund requires a captured payment."],
  RETURN_WINDOW_EXPIRED: [422, "The configured return window has expired."],
  RETURN_REASON_NOT_ALLOWED: [422, "The reason is not allowed by tenant policy."],
  MANUAL_REFUND_NOT_ALLOWED: [422, "Manual settlement is not allowed for this payment or policy."],
  IDEMPOTENCY_CONFLICT: [409, "The key was already used for a different intent."],
} as const;
export class ReturnError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.httpStatus = errors[code][0];
  }
}
export function returnDatabaseError(error: { code?: string; message?: string }): Error {
  const codes: Record<string, keyof typeof errors> = {
    RT404: "RETURN_NOT_FOUND",
    RT400: "INVALID_RETURN",
    RTLIN: "ORDER_LINE_MISMATCH",
    RTQTY: "RETURN_QUANTITY_EXCEEDED",
    RT409: "REFUND_CONFLICT",
    RTLOC: "RESTOCK_LOCATION_UNAVAILABLE",
    ID409: "IDEMPOTENCY_CONFLICT",
    "22003": "INVALID_RETURN",
    "22P02": "INVALID_RETURN",
  };
  if (error.code === "RT422" && error.message && Object.hasOwn(errors, error.message))
    return new ReturnError(error.message as keyof typeof errors);
  const code = error.code ? codes[error.code] : undefined;
  return code ? new ReturnError(code) : new Error("Unexpected return persistence failure.");
}
