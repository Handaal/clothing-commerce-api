// Error mapping for the customer accounts-receivable (installments) write surface. The SECURITY DEFINER
// functions in customers_ar_private raise bespoke SQLSTATEs (CA404/CA409/CA422) plus the shared ID409
// intent-conflict code; translate those into stable HTTP statuses the route layer can surface.
const errors = {
  CUSTOMER_NOT_FOUND: [404, "The requested customer does not exist."],
  PAYMENT_EXCEEDS_OUTSTANDING: [409, "The payment exceeds the customer's outstanding balance."],
  INVALID_CUSTOMER_PAYMENT: [422, "The customer payment request is not valid."],
  IDEMPOTENCY_CONFLICT: [409, "The idempotency key was reused with a different payload."],
} as const;

export class CustomerArError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "CustomerArError";
    this.httpStatus = errors[code][0];
  }
}

export function customerArDatabaseError(error: { code?: string }) {
  switch (error.code) {
    case "CA404":
      return new CustomerArError("CUSTOMER_NOT_FOUND");
    case "CA409":
      return new CustomerArError("PAYMENT_EXCEEDS_OUTSTANDING");
    case "ID409":
      return new CustomerArError("IDEMPOTENCY_CONFLICT");
    case "CA422":
    case "22023":
    case "23514":
      return new CustomerArError("INVALID_CUSTOMER_PAYMENT");
    default:
      return new Error("An unexpected customer A/R persistence error occurred.");
  }
}
