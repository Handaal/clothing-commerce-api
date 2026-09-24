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

export const PosContextRegisterSchema = z.object({
  registerId: UuidSchema,
  registerName: z.string().min(1),
  branchId: UuidSchema,
  branchName: z.string().min(1),
  defaultInventoryLocationId: UuidSchema,
  defaultInventoryLocationName: z.string().min(1),
  sellingCurrency: CurrencySchema,
  canSell: z.literal(true),
});

export const PosContextResponseSchema = z.object({
  registers: z.array(PosContextRegisterSchema),
});

export const CreatePosSaleRequestSchema = z
  .object({
    registerId: UuidSchema,
    // The expected NET total after any promotion; the server re-derives and rejects a stale value.
    expectedTotalMinor: NonNegativeIntegerSchema,
    cashReceivedMinor: NonNegativeIntegerSchema,
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
  .strict();

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

export const CashPaymentSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  method: z.literal("cash"),
  status: z.literal("captured"),
  currency: CurrencySchema,
  amountMinor: NonNegativeIntegerSchema,
  cashReceivedMinor: NonNegativeIntegerSchema,
  changeMinor: NonNegativeIntegerSchema,
  capturedByMembershipId: UuidSchema,
  capturedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

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
  payment: CashPaymentSchema,
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
  payment: CashPaymentSchema,
  fulfillment: PosFulfillmentSchema.nullable(),
  reconciliation: OfflineReconciliationSchema.nullable(),
});

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
