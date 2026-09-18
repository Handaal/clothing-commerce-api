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
}
