import { z } from "zod";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common/serialization";
import { PricingBreakdownSchema, PromotionCodeInputSchema } from "./common/promotion-pricing";

const UuidSchema = z.string().uuid();
const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

/** Server-owned branch identity for receipt rendering. Not a receipt template. */
export const PosBranchIdentitySchema = z.object({
  displayName: z.string().min(1),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  receiptFooter: z.string().nullable(),
});

/** Server-owned tenant business identity for receipt rendering. */
export const PosBusinessIdentitySchema = z.object({
  displayName: z.string().min(1),
  legalName: z.string().nullable(),
  taxIdentifier: z.string().nullable(),
});

export const PosContextRegisterSchema = z.object({
  registerId: UuidSchema,
  registerName: z.string().min(1),
  branchId: UuidSchema,
  branchName: z.string().min(1),
  defaultInventoryLocationId: UuidSchema,
  defaultInventoryLocationName: z.string().min(1),
  sellingCurrency: CurrencySchema,
  canSell: z.literal(true),
  branch: PosBranchIdentitySchema,
});

export const PosContextResponseSchema = z.object({
  business: z.object({ tenant: PosBusinessIdentitySchema }),
  registers: z.array(PosContextRegisterSchema),
});

// Cashier-confirmed tender methods. card / instapay / wallet are recorded as exact captures (the
// cashier confirms the external terminal / transfer / wallet succeeded); only cash carries change.
export const PosTenderMethodSchema = z.enum(["cash", "card", "instapay", "wallet"]);

export const PosTenderInputSchema = z
  .object({
    method: PosTenderMethodSchema,
    amountMinor: PositiveIntegerSchema,
    // Physical cash handed over, for the cash tender only; change = cashReceivedMinor − amountMinor.
    cashReceivedMinor: NonNegativeIntegerSchema.optional(),
  })
  .strict();

// A sale is settled either by a single cash amount (cashReceivedMinor) or by an explicit split of
// tenders whose amounts sum to the authoritative net total. Exactly one of the two must be present.
export const CreatePosSaleRequestSchema = z
  .object({
    registerId: UuidSchema,
    // The expected NET total after any promotion; the server re-derives and rejects a stale value.
    expectedTotalMinor: NonNegativeIntegerSchema,
    cashReceivedMinor: NonNegativeIntegerSchema.optional(),
    tenders: z.array(PosTenderInputSchema).min(1).max(4).optional(),
    lines: z
      .array(
        z.object({
          variantId: UuidSchema,
          quantity: PositiveIntegerSchema,
        }),
      )
      .min(1),
    promotionCode: PromotionCodeInputSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.tenders === undefined && value.cashReceivedMinor === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message: "provide cashReceivedMinor or tenders",
      });
    }
    if (value.tenders !== undefined) {
      const methods = new Set<string>();
      for (const [index, tender] of value.tenders.entries()) {
        if (methods.has(tender.method))
          ctx.addIssue({
            code: "custom",
            path: ["tenders", index, "method"],
            message: "a method may appear at most once",
          });
        methods.add(tender.method);
        if (tender.method !== "cash" && tender.cashReceivedMinor !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["tenders", index, "cashReceivedMinor"],
            message: "cashReceivedMinor applies to the cash tender only",
          });
        if (
          tender.method === "cash" &&
          tender.cashReceivedMinor !== undefined &&
          tender.cashReceivedMinor < tender.amountMinor
        )
          ctx.addIssue({
            code: "custom",
            path: ["tenders", index, "cashReceivedMinor"],
            message: "cash received is below the cash tender amount",
          });
      }
    }
  });

// Non-consuming connected-POS pricing quote over the same engine (register context resolves currency).
export const PosQuoteRequestSchema = z
  .object({
    registerId: UuidSchema,
    lines: z.array(z.object({ variantId: UuidSchema, quantity: PositiveIntegerSchema })).min(1),
    promotionCode: PromotionCodeInputSchema.nullable().optional(),
  })
  .strict();
export const PosQuoteResponseSchema = PricingBreakdownSchema;

const PosOrderLineSchema = z.object({
  id: UuidSchema,
  lineNumber: PositiveIntegerSchema,
  variantId: UuidSchema,
  quantity: PositiveIntegerSchema,
  unitPriceMinor: NonNegativeIntegerSchema,
  lineTotalMinor: NonNegativeIntegerSchema,
  productName: z.string(),
  variantName: z.string().nullable(),
  sku: z.string(),
  optionSummary: z.string().nullable(),
});

const PosOrderSchema = z.object({
  id: UuidSchema,
  orderNumber: z.string(),
  channel: z.literal("pos"),
  status: z.literal("placed"),
  brandId: UuidSchema,
  branchId: UuidSchema,
  registerId: UuidSchema,
  currency: CurrencySchema,
  totalMinor: NonNegativeIntegerSchema,
  actorMembershipId: UuidSchema,
  placedAt: IsoDateTimeSchema,
  cancelledAt: z.null(),
  cancelledByMembershipId: z.null(),
  cancellationReason: z.null(),
  notes: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lines: z.array(PosOrderLineSchema).min(1),
});

// One captured POS tender. Cash carries cashReceived/change; non-cash tenders are exact captures
// with null cash fields. A cash-only sale produces exactly one row (method "cash").
export const PosPaymentSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  method: PosTenderMethodSchema,
  status: z.literal("captured"),
  currency: CurrencySchema,
  amountMinor: NonNegativeIntegerSchema,
  cashReceivedMinor: NonNegativeIntegerSchema.nullable(),
  changeMinor: NonNegativeIntegerSchema.nullable(),
  capturedByMembershipId: UuidSchema,
  capturedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

// Backward-compatible alias: the primary (cash-or-first) tender of a sale.
export const CashPaymentSchema = PosPaymentSchema;

const PosFulfillmentLineSchema = z.object({
  id: UuidSchema,
  lineNumber: PositiveIntegerSchema,
  orderLineId: UuidSchema,
  variantId: UuidSchema,
  quantity: PositiveIntegerSchema,
});

const PosFulfillmentSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  inventoryLocationId: UuidSchema,
  inventoryOperationId: UuidSchema,
  actorMembershipId: UuidSchema,
  fulfilledAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  lines: z.array(PosFulfillmentLineSchema).min(1),
});

export const CreatePosSaleResponseSchema = z.object({
  saleStatus: z.literal("completed"),
  order: PosOrderSchema,
  // `payment` is the primary (cash-or-first) tender; `payments` is the full split, summing to total.
  payment: PosPaymentSchema,
  payments: z.array(PosPaymentSchema).min(1),
  fulfillment: PosFulfillmentSchema,
});

export const EnrollPosDeviceRequestSchema = z
  .object({
    registerId: UuidSchema,
    installationId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    publicKey: z.object({
      algorithm: z.literal("Ed25519"),
      encoding: z.literal("spki_der_base64"),
      value: Base64Schema,
    }),
    clientVersion: z.string().trim().min(1).max(100).optional(),
    platform: z.string().trim().min(1).max(100).optional(),
    osVersion: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const PosDeviceResponseSchema = z.object({
  deviceId: UuidSchema,
  credentialId: UuidSchema,
  registerId: UuidSchema,
  status: z.enum(["active", "revoked"]),
  publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  activatedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
});

export const RotatePosDeviceCredentialRequestSchema = z
  .object({
    registerId: UuidSchema,
    publicKey: z.object({
      algorithm: z.literal("Ed25519"),
      encoding: z.literal("spki_der_base64"),
      value: Base64Schema,
    }),
  })
  .strict();

export const RevokePosDeviceRequestSchema = z
  .object({ registerId: UuidSchema, reason: z.string().trim().min(1).max(500) })
  .strict();

export const OfflinePolicySchema = z.object({
  enabled: z.boolean(),
  operatorLeaseSeconds: PositiveIntegerSchema,
  catalogGrantSeconds: PositiveIntegerSchema,
  maxSaleAmountMinor: NonNegativeIntegerSchema,
  maxCumulativeExposureMinor: NonNegativeIntegerSchema,
  maxQuantityPerLine: PositiveIntegerSchema,
  maxPendingOfflineSales: PositiveIntegerSchema,
});

const OfflineCatalogVariantSchema = z.object({
  variantId: UuidSchema,
  sku: z.string(),
  optionSummary: z.string().nullable(),
  active: z.boolean(),
  authorizedUnitPriceMinor: NonNegativeIntegerSchema,
  priceId: UuidSchema,
  priceVersion: IsoDateTimeSchema,
  advisoryInventory: z.object({
    onHandQuantity: NonNegativeIntegerSchema,
    version: NonNegativeIntegerSchema,
    asOf: IsoDateTimeSchema,
  }),
});

const OfflineCatalogProductSchema = z.object({
  productId: UuidSchema,
  brandId: UuidSchema,
  name: z.string(),
  active: z.boolean(),
  variants: z.array(OfflineCatalogVariantSchema),
});

export const OfflineBootstrapRequestSchema = z
  .object({ deviceId: UuidSchema, registerId: UuidSchema })
  .strict();

export const OfflineBootstrapResponseSchema = z.object({
  grantId: UuidSchema,
  snapshotId: UuidSchema,
  schemaVersion: z.literal(1),
  minimumClientVersion: z.string(),
  tenantId: UuidSchema,
  deviceId: UuidSchema,
  registerId: UuidSchema,
  branchId: UuidSchema,
  inventoryLocationId: UuidSchema,
  operatorMembershipId: UuidSchema,
  currency: CurrencySchema,
  issuedAt: IsoDateTimeSchema,
  operatorExpiresAt: IsoDateTimeSchema,
  catalogValidUntil: IsoDateTimeSchema,
  acceptedUntil: IsoDateTimeSchema,
  policy: OfflinePolicySchema,
  catalog: z.array(OfflineCatalogProductSchema),
});

export const OfflineSaleCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    localSaleId: z.string().trim().min(1).max(200),
    syncCommandId: UuidSchema,
    grantId: UuidSchema,
    deviceId: UuidSchema,
    registerId: UuidSchema,
    acceptedAt: IsoDateTimeSchema,
    currency: CurrencySchema,
    lines: z
      .array(
        z
          .object({
            variantId: UuidSchema,
            quantity: PositiveIntegerSchema,
            grantedUnitPriceMinor: NonNegativeIntegerSchema,
            priceId: UuidSchema,
          })
          .strict(),
      )
      .min(1),
    totalMinor: NonNegativeIntegerSchema,
    cashReceivedMinor: NonNegativeIntegerSchema,
    changeMinor: NonNegativeIntegerSchema,
    // Optional split tender. When present, the tender amounts sum to totalMinor; the cash tender's
    // cashReceived/change mirror the top-level cashReceivedMinor/changeMinor. Absent ⇒ cash-only.
    tenders: z.array(PosTenderInputSchema).min(1).max(4).optional(),
    offlineSaleOrdinal: PositiveIntegerSchema,
    cumulativeExposureMinor: NonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const variants = new Set<string>();
    for (const [index, line] of value.lines.entries()) {
      if (variants.has(line.variantId))
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "variantId"],
          message: "a variant may appear at most once",
        });
      variants.add(line.variantId);
    }
    if (value.tenders !== undefined) {
      const methods = new Set<string>();
      let sum = 0;
      for (const [index, tender] of value.tenders.entries()) {
        if (methods.has(tender.method))
          ctx.addIssue({
            code: "custom",
            path: ["tenders", index, "method"],
            message: "a method may appear at most once",
          });
        methods.add(tender.method);
        sum += tender.amountMinor;
      }
      if (sum !== value.totalMinor)
        ctx.addIssue({
          code: "custom",
          path: ["tenders"],
          message: "tenders must sum to totalMinor",
        });
    }
  });

export const IngestOfflineSaleRequestSchema = z
  .object({
    command: OfflineSaleCommandSchema,
    signature: z.object({
      algorithm: z.literal("Ed25519"),
      credentialId: UuidSchema,
      value: Base64Schema,
    }),
  })
  .strict();

export const OfflineReconciliationSchema = z.object({
  id: UuidSchema,
  reason: z.enum(["insufficient_stock_at_ingestion", "device_revoked_at_ingestion"]),
  status: z.literal("open"),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const IngestOfflineSaleResponseSchema = z.object({
  syncStatus: z.enum(["synced", "needs_reconciliation"]),
  ingestionId: UuidSchema,
  localSaleId: z.string(),
  receivedAt: IsoDateTimeSchema,
  order: PosOrderSchema,
  payment: PosPaymentSchema,
  payments: z.array(PosPaymentSchema).min(1).optional(),
  fulfillment: PosFulfillmentSchema.nullable(),
  reconciliation: OfflineReconciliationSchema.nullable(),
});

export type PosTenderMethod = z.infer<typeof PosTenderMethodSchema>;
export type PosTenderInput = z.infer<typeof PosTenderInputSchema>;
export type PosPayment = z.infer<typeof PosPaymentSchema>;
export type PosContextResponse = z.infer<typeof PosContextResponseSchema>;
export type PosQuoteRequest = z.infer<typeof PosQuoteRequestSchema>;
export type PosQuoteResponse = z.infer<typeof PosQuoteResponseSchema>;
export type CreatePosSaleRequest = z.infer<typeof CreatePosSaleRequestSchema>;
export type CreatePosSaleResponse = z.infer<typeof CreatePosSaleResponseSchema>;
export type EnrollPosDeviceRequest = z.infer<typeof EnrollPosDeviceRequestSchema>;
export type PosDeviceResponse = z.infer<typeof PosDeviceResponseSchema>;
export type RotatePosDeviceCredentialRequest = z.infer<
  typeof RotatePosDeviceCredentialRequestSchema
>;
export type RevokePosDeviceRequest = z.infer<typeof RevokePosDeviceRequestSchema>;
export type OfflinePolicy = z.infer<typeof OfflinePolicySchema>;
export type OfflineBootstrapRequest = z.infer<typeof OfflineBootstrapRequestSchema>;
export type OfflineBootstrapResponse = z.infer<typeof OfflineBootstrapResponseSchema>;
export type OfflineSaleCommand = z.infer<typeof OfflineSaleCommandSchema>;
export type IngestOfflineSaleRequest = z.infer<typeof IngestOfflineSaleRequestSchema>;
export type IngestOfflineSaleResponse = z.infer<typeof IngestOfflineSaleResponseSchema>;
