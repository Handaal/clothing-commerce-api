/** Server-only boundary. A selected provider must implement this before electronic checkout is enabled.
 * Persist a pending attempt/outbox first, commit, then call authorize using that attempt's stable key.
 * Verified webhook events reconcile through the payment transition function; browser redirects never capture.
 */
export interface PaymentProvider {
  readonly provider: string;
  authorize(input: {
    paymentId: string;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
    returnUrl: string;
  }): Promise<{ providerReference: string; redirectUrl: string | null }>;
  verifyWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<{
    eventId: string;
    providerReference: string;
    status: "authorized" | "captured" | "failed" | "cancelled";
    amountMinor: number;
    currency: string;
  }>;
  void(input: { providerReference: string; idempotencyKey: string }): Promise<void>;
  /** A durable pending Refund reserves the amount before this call. Commit before calling the
   * gateway. Retry with the refund ID as provider idempotency key. Success requires verified
   * provider evidence, never merely an accepted request or a browser redirect. */
  refund(input: {
    paymentReference: string;
    refundId: string;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ providerReference: string; status: "pending" | "succeeded" | "failed" }>;
}
