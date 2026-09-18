import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CheckoutResultSchema,
  type CheckoutRequest,
  type CheckoutResult,
} from "../contracts/storefront/checkout";

const errors = {
  CHECKOUT_UNAVAILABLE: [422, "Checkout is unavailable for this Storefront."],
  VARIANT_NOT_SELLABLE: [422, "A requested variant is no longer available for purchase."],
  PRICE_CHANGED: [409, "The current order total has changed. Review it before retrying."],
  CURRENCY_CHANGED: [409, "The Storefront currency has changed. Reload the cart."],
  INSUFFICIENT_STOCK: [409, "There is insufficient available stock for this cart."],
  IDEMPOTENCY_CONFLICT: [409, "This checkout key was already used for different intent."],
  INVALID_CHECKOUT: [400, "The checkout intent is invalid."],
} as const;
export class CheckoutError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: keyof typeof errors,
    readonly totalMinor?: number,
  ) {
    super(errors[code][1]);
    this.httpStatus = errors[code][0];
  }
}
export interface CheckoutRepository {
  place(key: string, intent: CheckoutRequest): Promise<CheckoutResult>;
}
export class CheckoutService {
  constructor(private readonly repository: CheckoutRepository) {}
  place(key: string, intent: CheckoutRequest): Promise<CheckoutResult> {
    if (new Set(intent.lines.map((line) => line.variantId)).size !== intent.lines.length) {
      throw new CheckoutError("INVALID_CHECKOUT");
    }
    return this.repository.place(key, intent);
  }
}
export class SupabaseCheckoutRepository implements CheckoutRepository {
  constructor(private readonly client: SupabaseClient) {}
  async place(key: string, intent: CheckoutRequest): Promise<CheckoutResult> {
    const { data, error } = await this.client
      .schema("online_private")
      .rpc("place_checkout", { p_key: key, p_intent: intent });
    if (error) {
      const codes: Record<string, keyof typeof errors> = {
        OC001: "CHECKOUT_UNAVAILABLE",
        OC002: "VARIANT_NOT_SELLABLE",
        OC003: "PRICE_CHANGED",
        OC004: "CURRENCY_CHANGED",
        "23514": "INSUFFICIENT_STOCK",
        ID409: "IDEMPOTENCY_CONFLICT",
        "22023": "INVALID_CHECKOUT",
      };
      const code = codes[error.code];
      if (code) {
        const total = code === "PRICE_CHANGED" ? Number(error.details) : undefined;
        throw new CheckoutError(
          code,
          total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined,
        );
      }
      throw new Error("Unexpected checkout persistence failure.");
    }
    return CheckoutResultSchema.parse(data);
  }
}
export function createCheckoutService(configuration: {
  url: string;
  serviceRoleKey: string;
}): CheckoutService {
  return new CheckoutService(
    new SupabaseCheckoutRepository(
      createClient(configuration.url, configuration.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    ),
  );
}
