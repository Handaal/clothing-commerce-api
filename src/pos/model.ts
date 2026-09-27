import { z } from "zod";

const UuidSchema = z.string().uuid();
const MoneySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const QuantitySchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const PromotionCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable()
  .optional();

export const CreatePosSaleInputSchema = z
  .object({
    registerId: UuidSchema,
    expectedTotalMinor: MoneySchema,
    cashReceivedMinor: MoneySchema,
    lines: z.array(z.object({ variantId: UuidSchema, quantity: QuantitySchema }).strict()).min(1),
    promotionCode: PromotionCodeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, line] of value.lines.entries()) {
      if (seen.has(line.variantId)) {
        ctx.addIssue({
          code: "custom",
          message: "a variant may appear at most once in a POS sale",
          path: ["lines", index, "variantId"],
        });
      }
      seen.add(line.variantId);
    }
  });

export type CreatePosSaleInput = z.infer<typeof CreatePosSaleInputSchema>;

export const PosPermission = {
  createOrder: "orders.create",
  fulfillOrder: "orders.fulfill",
  readOrder: "orders.read",
  issueInventory: "inventory.issue",
  capturePayment: "payments.capture",
} as const;

/** Server-owned branch identity for receipt rendering. Uses only real branch columns. */
export interface PosBranchIdentity {
  readonly displayName: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly receiptFooter: string | null;
}

/** Server-owned tenant business identity for receipt rendering. */
export interface PosBusinessIdentity {
  readonly displayName: string;
  readonly legalName: string | null;
  readonly taxIdentifier: string | null;
}

export interface PosRegisterContext {
  readonly registerId: string;
  readonly registerName: string;
  readonly registerStatus: "active" | "inactive" | "archived";
  readonly branchId: string;
  readonly branchName: string;
  readonly branchStatus: "active" | "inactive" | "archived";
  readonly inventoryLocationId: string;
  readonly inventoryLocationName: string;
  readonly inventoryLocationStatus: "active" | "inactive" | "archived";
  readonly fulfillmentEnabled: boolean;
  readonly sellingCurrency: string;
  readonly branch: PosBranchIdentity;
}

export interface PosContextResult {
  readonly business: {
    readonly tenant: PosBusinessIdentity;
  };
  readonly registers: readonly {
    readonly registerId: string;
    readonly registerName: string;
    readonly branchId: string;
    readonly branchName: string;
    readonly defaultInventoryLocationId: string;
    readonly defaultInventoryLocationName: string;
    readonly sellingCurrency: string;
    readonly canSell: true;
    readonly branch: PosBranchIdentity;
  }[];
}

export interface ResolvedPosSaleLine {
  readonly variantId: string;
  readonly productId: string;
  readonly brandId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly optionSummary: string | null;
}

export interface PaymentResult {
  readonly id: string;
  readonly orderId: string;
  readonly method: "cash";
  readonly status: "captured";
  readonly currency: string;
  readonly amountMinor: number;
  readonly cashReceivedMinor: number;
  readonly changeMinor: number;
  readonly capturedByMembershipId: string;
  readonly capturedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PosSaleResult {
  readonly saleStatus: "completed";
  readonly order: import("../orders/model").OrderResult;
  readonly payment: PaymentResult;
  readonly fulfillment: import("../fulfillments/model").FulfillmentResult;
}

export interface PosSaleIntent {
  readonly registerId: string;
  readonly expectedTotalMinor: number;
  readonly cashReceivedMinor: number;
  readonly lines: readonly { readonly variantId: string; readonly quantity: number }[];
  readonly promotionCode: string | null;
}

export interface PosQuoteInput {
  readonly registerId: string;
  readonly lines: readonly { readonly variantId: string; readonly quantity: number }[];
  readonly promotionCode: string | null;
}

export type PosSaleReplayTarget =
  | { readonly kind: "none" }
  | {
      readonly kind: "conflict";
      readonly branchId: string;
      readonly inventoryLocationId: string;
    }
  | {
      readonly kind: "replay";
      readonly saleId: string;
      readonly branchId: string;
      readonly inventoryLocationId: string;
    };
