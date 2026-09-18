import { describe, expect, it } from "vitest";
import { CheckoutRequestSchema } from "../../src/contracts/storefront/checkout";
import { CheckoutError, CheckoutService } from "../../src/checkout/checkout-service";

export const intent = {
  tenantId: "2a000001-0000-4000-8000-000000000001",
  brandId: "2a000002-0000-4000-8000-000000000001",
  lines: [{ variantId: "2a000007-0000-4000-8000-000000000001", quantity: 1 }],
  customer: { name: "Guest", phone: "+20 100 123 4567", email: "Guest@example.com" },
  delivery: {
    recipientName: "Recipient",
    phone: "+201001234567",
    line1: "10 Example Street",
    line2: null,
    city: "Cairo",
    region: null,
    postalCode: null,
    countryCode: "EG",
    notes: null,
  },
  expectedTotalMinor: 2500,
  expectedCurrency: "USD",
  paymentMethod: "cash_on_delivery" as const,
};
describe("online checkout intent", () => {
  it("accepts guest intent and rejects authoritative/client internal fields", () => {
    expect(CheckoutRequestSchema.safeParse(intent).success).toBe(true);
    for (const field of [
      "unitPriceMinor",
      "inventoryLocationId",
      "customerId",
      "capturedAmountMinor",
    ]) {
      expect(CheckoutRequestSchema.safeParse({ ...intent, [field]: 1 }).success).toBe(false);
    }
  });
  it("requires bounded quantities, expected total/currency and explicit international phone", () => {
    expect(
      CheckoutRequestSchema.safeParse({ ...intent, lines: [{ ...intent.lines[0], quantity: 0 }] })
        .success,
    ).toBe(false);
    expect(
      CheckoutRequestSchema.safeParse({ ...intent, expectedTotalMinor: undefined }).success,
    ).toBe(false);
    expect(
      CheckoutRequestSchema.safeParse({
        ...intent,
        customer: { ...intent.customer, phone: "01001234567" },
      }).success,
    ).toBe(false);
  });
  it("rejects duplicate variants before persistence", () => {
    const service = new CheckoutService({
      place: () => {
        throw new Error("must not call persistence");
      },
    });
    expect(() =>
      service.place("key", { ...intent, lines: [...intent.lines, ...intent.lines] }),
    ).toThrow(CheckoutError);
  });
});
