import { z } from "zod";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common/serialization";
import { PricingBreakdownSchema, PromotionCodeInputSchema } from "./common/promotion-pricing";

const UuidSchema = z.string().uuid();

/**
 * ADR-043 §6 — THE POS PIN rule, shared by every contract that carries a POS PIN (sign-in, provisioning, PIN
 * reset, override-password re-auth, offline-enrollment step-up): ASCII digits only, at least 4, and NO product
 * maximum. Oversized requests are refused by the route's transport ceiling (413), never by this schema, and a
 * PIN is never truncated.
 */
export const POS_PIN_MIN_LENGTH = 4;
export const PosPinSchema = z
  .string()
  .regex(/^[0-9]+$/, "PIN must contain only the digits 0-9")
  .min(POS_PIN_MIN_LENGTH, "PIN must be at least 4 digits");
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

export const PosAvailabilityResponseSchema = z.object({
  registerId: UuidSchema,
  items: z.array(z.object({ variantId: UuidSchema, onHand: NonNegativeIntegerSchema })),
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

// Optional customer captured at the register. The phone is matched (create-or-match) to a tenant
// customer by its normalized form; name/phone are snapshotted onto the order. Normalization strips
// everything but + and digits; the result must be E.164 so it can be matched and stored.
export const PosCustomerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    phone: z.string().trim().min(1).max(32),
  })
  .strict()
  .refine((value) => /^\+[1-9][0-9]{6,14}$/.test(value.phone.replace(/[^+0-9]/g, "")), {
    path: ["phone"],
    message: "phone must be a valid international number",
  });

// A sale is settled either by a single cash amount (cashReceivedMinor) or by an explicit split of
// tenders whose amounts sum to the authoritative net total. Exactly one of the two must be present.
export const CreatePosSaleRequestSchema = z
  .object({
    registerId: UuidSchema,
    // The expected NET total after any promotion; the server re-derives and rejects a stale value.
    expectedTotalMinor: NonNegativeIntegerSchema,
    cashReceivedMinor: NonNegativeIntegerSchema.optional(),
    tenders: z.array(PosTenderInputSchema).min(1).max(4).optional(),
    // Optional; when present the sale links/creates a customer by phone and snapshots the contact.
    customer: PosCustomerInputSchema.optional(),
    // Installment deposit. When omitted the sale is settled in full. When present and below the net
    // total, the remainder becomes a customer debt — so a positive deposit and a customer are required.
    amountPaidMinor: NonNegativeIntegerSchema.optional(),
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
    if (value.amountPaidMinor !== undefined) {
      if (value.amountPaidMinor > value.expectedTotalMinor) {
        ctx.addIssue({
          code: "custom",
          path: ["amountPaidMinor"],
          message: "amountPaidMinor cannot exceed expectedTotalMinor",
        });
      }
      if (value.amountPaidMinor < value.expectedTotalMinor) {
        if (value.amountPaidMinor <= 0) {
          ctx.addIssue({
            code: "custom",
            path: ["amountPaidMinor"],
            message: "an installment sale requires a positive deposit",
          });
        }
        if (value.customer === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["customer"],
            message: "an installment sale requires a customer",
          });
        }
      }
    }
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

// All-desks offline program — OFFLINE OPERATION INTENTS with AUTOMATIC SERVER DISPOSITION. One shared signed
// lane for desk actions a till may capture offline. On sync the server validates the signed command under its
// grant and the register's handler policy and, in the same transaction that stores it, either applies the
// typed business effect (applied), refuses it (rejected), records a conflict for operator reconciliation
// (needs_reconciliation) or fails closed because no approved handler policy exists (blocked_policy). There is
// NO human/admin approval step and no pending state. Every operation is disabled unless the register's
// policy opts in (offline_pos_policies.offline_intent_operations). No money is computed and no discount is
// applied here; client JSON never addresses a table.
export const OfflineIntentOperationSchema = z.enum([
  "inventory.receive",
  "inventory.adjust",
  "inventory.count",
  "suppliers.purchase_draft",
  "suppliers.goods_receipt",
  "suppliers.payment_intent",
  "staff.attendance_correction_request",
  "staff.role_change_request",
  "settings.change_request",
  "settings.device_revoke_request",
  "customers.create",
  "customers.update",
  "review.resolution_request",
]);

const IntentNoteSchema = z.string().trim().max(500).nullable();
const IntentQuantitySchema = z.number().int().min(1).max(100_000);
const IntentReasonSchema = z.string().trim().min(1).max(500);

const InventoryReceivePayloadSchema = z
  .object({
    variantId: UuidSchema,
    quantity: IntentQuantitySchema,
    // Physical evidence for goods received while disconnected (delivery note / supplier doc reference).
    supplierDocumentRef: z.string().trim().max(200).nullable(),
    note: IntentNoteSchema,
  })
  .strict();
const InventoryAdjustPayloadSchema = z
  .object({
    variantId: UuidSchema,
    quantityDelta: z
      .number()
      .int()
      .min(-100_000)
      .max(100_000)
      .refine((value) => value !== 0, "quantityDelta must not be zero."),
    reason: z.enum(["damaged", "lost", "found", "correction", "other"]),
    note: IntentNoteSchema,
  })
  .strict();
const InventoryCountPayloadSchema = z
  .object({
    variantId: UuidSchema,
    countedQuantity: z.number().int().min(0).max(1_000_000),
    // The advisory on-hand the till displayed when counting (evidence only; never canonical).
    observedAdvisoryQuantity: z.number().int().min(0).max(1_000_000).nullable(),
    note: IntentNoteSchema,
  })
  .strict();
const SupplierLinePayloadSchema = z
  .object({ variantId: UuidSchema, quantity: IntentQuantitySchema })
  .strict();
const SupplierPurchaseDraftPayloadSchema = z
  .object({
    supplierId: UuidSchema,
    lines: z.array(SupplierLinePayloadSchema).min(1).max(100),
    supplierDocumentRef: z.string().trim().max(200).nullable(),
    note: IntentNoteSchema,
  })
  .strict();
const SupplierGoodsReceiptPayloadSchema = z
  .object({
    supplierId: UuidSchema,
    purchaseId: UuidSchema.nullable(),
    lines: z.array(SupplierLinePayloadSchema).min(1).max(100),
    supplierDocumentRef: z.string().trim().max(200).nullable(),
    note: IntentNoteSchema,
  })
  .strict();
const SupplierPaymentIntentPayloadSchema = z
  .object({
    supplierId: UuidSchema,
    // The stated intent only — explicitly NOT a settled payment.
    amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    method: z.enum(["cash", "bank_transfer", "other"]),
    note: IntentNoteSchema,
  })
  .strict();
const StaffAttendanceCorrectionPayloadSchema = z
  .object({
    membershipId: UuidSchema,
    // A local offline attendance event id or a server attendance entry id the correction refers to.
    referenceId: z.string().trim().min(1).max(200).nullable(),
    requestedEventType: z.enum(["clock_in", "clock_out"]),
    requestedAt: IsoDateTimeSchema,
    reason: IntentReasonSchema,
  })
  .strict();
const StaffRoleChangePayloadSchema = z
  .object({ membershipId: UuidSchema, requestedRoleId: UuidSchema, reason: IntentReasonSchema })
  .strict();
const SettingsChangePayloadSchema = z
  .object({
    settingKey: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_.]*$/),
    requestedValue: z.string().max(500),
    reason: IntentReasonSchema,
  })
  .strict();
const SettingsDeviceRevokePayloadSchema = z
  .object({ targetDeviceId: UuidSchema, reason: IntentReasonSchema })
  .strict();
const CustomerCreatePayloadSchema = z
  .object({
    localCustomerId: UuidSchema,
    displayName: z.string().trim().min(1).max(120),
    // Additional PII fields are intentionally absent until the owner approves an offline field set.
    phone: z.string().trim().max(40).nullable(),
  })
  .strict();
const CustomerUpdatePayloadSchema = z
  .object({
    customerId: UuidSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
  })
  .strict();
const ReviewResolutionPayloadSchema = z
  .object({
    targetLane: z.enum(["sale", "payment", "attendance", "return", "intent"]),
    targetSyncCommandId: UuidSchema,
    requestKind: z.enum(["investigate", "confirm_physical_evidence", "void_request", "other"]),
    note: z.string().trim().min(1).max(1000),
  })
  .strict();

const OfflineIntentBaseSchema = z.object({
  schemaVersion: z.literal(1),
  localIntentId: z.string().trim().min(1).max(200),
  syncCommandId: UuidSchema,
  grantId: UuidSchema,
  deviceId: UuidSchema,
  registerId: UuidSchema,
  operatorMembershipId: UuidSchema,
  // Server identifier of the thing the intent is about (variant, supplier, membership, …), if any.
  subjectId: z.string().trim().min(1).max(200).nullable(),
  // Freshness evidence: the server version/snapshot the till observed when capturing (never authority).
  baseVersion: z.string().trim().min(1).max(200).nullable(),
  // Ordering: an intent that must not be received before another intent from the same device.
  dependsOnSyncCommandId: UuidSchema.nullable(),
  acceptedAt: IsoDateTimeSchema,
});

export const OfflineIntentCommandSchema = z.discriminatedUnion("operation", [
  OfflineIntentBaseSchema.extend({
    operation: z.literal("inventory.receive"),
    payload: InventoryReceivePayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("inventory.adjust"),
    payload: InventoryAdjustPayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("inventory.count"),
    payload: InventoryCountPayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("suppliers.purchase_draft"),
    payload: SupplierPurchaseDraftPayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("suppliers.goods_receipt"),
    payload: SupplierGoodsReceiptPayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("suppliers.payment_intent"),
    payload: SupplierPaymentIntentPayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("staff.attendance_correction_request"),
    payload: StaffAttendanceCorrectionPayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("staff.role_change_request"),
    payload: StaffRoleChangePayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("settings.change_request"),
    payload: SettingsChangePayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("settings.device_revoke_request"),
    payload: SettingsDeviceRevokePayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("customers.create"),
    payload: CustomerCreatePayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("customers.update"),
    payload: CustomerUpdatePayloadSchema,
  }).strict(),
  OfflineIntentBaseSchema.extend({
    operation: z.literal("review.resolution_request"),
    payload: ReviewResolutionPayloadSchema,
  }).strict(),
]);

export const IngestOfflineIntentRequestSchema = z
  .object({
    command: OfflineIntentCommandSchema,
    signature: z.object({
      algorithm: z.literal("Ed25519"),
      credentialId: UuidSchema,
      value: Base64Schema,
    }),
  })
  .strict();

// Final machine disposition, decided atomically at ingestion. There is deliberately no pending/approval value.
export const OfflineIntentDispositionSchema = z.enum([
  "applied",
  "rejected",
  "needs_reconciliation",
  "blocked_policy",
]);

// Safe outcome evidence only (ids/quantities/versions). Never PII, keys or signatures.
export const OfflineIntentDispositionDetailSchema = z
  .object({
    inventoryOperationId: UuidSchema.optional(),
    quantityDelta: z.number().int().optional(),
    onHandAfter: z.number().int().optional(),
    onHand: z.number().int().optional(),
    requested: z.number().int().optional(),
    limit: z.number().int().optional(),
    variance: z.number().int().optional(),
    baseVersion: z.string().optional(),
    currentVersion: z.number().int().optional(),
    deviceId: UuidSchema.optional(),
    dependencyDisposition: z.string().nullable().optional(),
    missing: z.string().optional(),
    sqlstate: z.string().optional(),
  })
  .strip();

export const IngestOfflineIntentResponseSchema = z.object({
  // "received": the signed command is durably stored together with its final disposition below.
  syncStatus: z.literal("received"),
  ingestionId: UuidSchema,
  localIntentId: z.string(),
  receivedAt: IsoDateTimeSchema,
  intent: z.object({
    operation: OfflineIntentOperationSchema,
    disposition: OfflineIntentDispositionSchema,
    // Machine-readable reason: OIA_* (applied), OIX_* (rejected / conflict), OIP_* (policy missing/invalid).
    code: z.string().min(1).max(64),
    policyVersion: z.string().nullable(),
    decidedAt: IsoDateTimeSchema,
    detail: OfflineIntentDispositionDetailSchema,
  }),
});

export const OfflinePolicySchema = z.object({
  enabled: z.boolean(),
  operatorLeaseSeconds: PositiveIntegerSchema,
  catalogGrantSeconds: PositiveIntegerSchema,
  maxSaleAmountMinor: NonNegativeIntegerSchema,
  maxCumulativeExposureMinor: NonNegativeIntegerSchema,
  maxQuantityPerLine: PositiveIntegerSchema,
  maxPendingOfflineSales: PositiveIntegerSchema,
  // Dedicated cap on the total UNPAID remainder a till may extend offline as customer installments,
  // separate from the cash-sale cumulative exposure above. Defaults to 0 so a server (or policy) that
  // has not enabled offline credit simply disallows offline installments while every other capability
  // stays intact — mirroring how an absent staff roster disables offline PIN unlock.
  maxOfflineCreditExposureMinor: NonNegativeIntegerSchema.default(0),
  // Provisional offline intent operations this register opts into. Absent on an older server => none.
  intentOperations: z.array(OfflineIntentOperationSchema).default([]),
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

// Classification travels with the offline snapshot so the till browses by category and searches by
// brand with the same server-authoritative data the connected clients use. `brandName` is nullable
// (the brand may have been removed); `categories` is the product's non-archived collection memberships.
const OfflineCatalogCategorySchema = z.object({
  id: UuidSchema,
  name: z.string(),
});

const OfflineCatalogProductSchema = z.object({
  productId: UuidSchema,
  brandId: UuidSchema,
  name: z.string(),
  active: z.boolean(),
  // Defaulted so a client on this contract still validates a snapshot from a server that predates the
  // classification migration (it simply sees an unbranded, uncategorized product) rather than failing
  // the whole bootstrap. A current server always populates both.
  brandName: z.string().nullable().default(null),
  categories: z.array(OfflineCatalogCategorySchema).default([]),
  variants: z.array(OfflineCatalogVariantSchema),
});

// A customer the till may attach an installment to while offline. Carries the current authoritative
// outstanding balance so the cashier sees a running tab and the client can enforce the offline credit
// cap before a connection is available. `customerId` is the real customers.id the signed command
// references, so server ingest needs no name/phone upsert.
export const OfflineCustomerSnapshotSchema = z
  .object({
    customerId: UuidSchema,
    name: z.string(),
    phone: z.string(),
    outstandingMinor: NonNegativeIntegerSchema,
  })
  .strict();

export const OfflineBootstrapRequestSchema = z
  .object({
    deviceId: UuidSchema,
    registerId: UuidSchema,
    // ADR-042 §4/§5: at a fresh bootstrap the till closes its previous offline grant by reporting the last
    // offline sale ordinal it made under it; unconsumed stock and voucher quota return to the pool.
    closePreviousGrant: z
      .object({ offlineGrantId: UuidSchema, finalSaleOrdinal: NonNegativeIntegerSchema })
      .strict()
      .optional(),
  })
  .strict();

// ADR-042 §4 offline POS stock grant: the per-variant quantities this till may sell offline.
export const OfflineStockGrantSchema = z
  .object({
    stockGrantId: UuidSchema,
    offlineGrantId: UuidSchema,
    status: z.enum(["active", "closed", "expired", "revoked"]),
    expiresAt: IsoDateTimeSchema,
    // true when the location's channel stock is enforced: the till sells offline only within the lines.
    enforced: z.boolean(),
    lines: z.array(
      z
        .object({
          variantId: UuidSchema,
          grantedQuantity: NonNegativeIntegerSchema,
          consumedQuantity: NonNegativeIntegerSchema,
          releasedQuantity: NonNegativeIntegerSchema,
        })
        .strict(),
    ),
  })
  .strict();

// A device-bound scrypt verifier for the POS offline cashier unlock. The POS re-derives
// scrypt(pin, saltBytes || utf8(deviceId), keyLength, { N, r, p }) and compares against hashBase64.
export const StaffPinVerifierSchema = z
  .object({
    algorithm: z.literal("scrypt"),
    saltBase64: Base64Schema,
    hashBase64: Base64Schema,
    n: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    keyLength: z.number().int().min(16),
  })
  .strict();

export const OfflineStaffRosterEntrySchema = z
  .object({
    membershipId: UuidSchema,
    username: z.string().min(1),
    displayName: z.string().min(1),
    pinVerifier: StaffPinVerifierSchema,
  })
  .strict();

// Request body for setting/rotating a staff member's offline-unlock PIN (membershipId is a path param).
// A numeric till PIN (ADR-043 rule: digits, min 4, no product max); the server seals it and never returns it.
export const SetStaffOfflinePinRequestSchema = z.object({ pin: PosPinSchema }).strict();

export const SetStaffOfflinePinResponseSchema = z
  .object({
    membershipId: UuidSchema,
    keyVersion: z.number().int().positive(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const OfflineVoucherTermsSchema = z
  .object({
    promotionId: UuidSchema,
    name: z.string(),
    codeId: UuidSchema.nullable(),
    code: z.string().nullable(),
    benefitType: z.enum(["percentage", "fixed_amount"]),
    benefitPercentBp: z.number().int().nullable(),
    benefitAmountMinor: NonNegativeIntegerSchema.nullable(),
    benefitCurrency: CurrencySchema.nullable(),
    targetType: z.enum(["order", "variant_scope"]),
    minSubtotalMinor: NonNegativeIntegerSchema.nullable(),
    maxDiscountMinor: NonNegativeIntegerSchema.nullable(),
    endsAt: IsoDateTimeSchema.nullable(),
    targetProductIds: z.array(UuidSchema),
    targetVariantIds: z.array(UuidSchema),
  })
  .strict();

export const OfflineVoucherGrantSchema = z
  .object({
    voucherGrantId: UuidSchema,
    promotionId: UuidSchema,
    codeId: UuidSchema.nullable(),
    status: z.enum(["active", "closed", "expired", "revoked"]),
    allowedCount: NonNegativeIntegerSchema,
    consumedCount: NonNegativeIntegerSchema,
    releasedCount: NonNegativeIntegerSchema,
    maxDiscountPerRedemptionMinor: PositiveIntegerSchema,
    maxDiscountPerGrantMinor: PositiveIntegerSchema,
    discountConsumedMinor: NonNegativeIntegerSchema,
    requiresAdminCredentials: z.boolean(),
    // 'ov1' = the documented offline discount formula (mirrors the canonical evaluator for % and fixed).
    calculationVersion: z.literal("ov1"),
    expiresAt: IsoDateTimeSchema,
    terms: OfflineVoucherTermsSchema,
  })
  .strict();

// ADR-042 §13.6: the cached policy of ONE existing voucher code, recorded server-side per offline lease at
// bootstrap. It reserves nothing: `observedRemaining` is the SHARED remaining usage seen at fetch time (null =
// no finite limit) and the Website keeps consuming the same limit. The till never receives the raw code, only
// `codeFingerprint` = sha256hex(`${tenantId}:${NORMALIZED_CODE}`). `policyDigest` is an opaque server digest the
// till echoes in the device-signed sale command; the server rejects (as a VX_SNAPSHOT_INVALID exception) any
// digest it did not issue to that lease. Credential-gated vouchers are never issued here.
export const OfflineVoucherPolicySchema = z
  .object({
    policyIssuanceId: UuidSchema,
    promotionId: UuidSchema,
    codeId: UuidSchema,
    codeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    channelPolicyVersion: PositiveIntegerSchema,
    policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    calculationVersion: z.literal("ov1"),
    observedRemaining: PositiveIntegerSchema.nullable(),
    maxDiscountPerRedemptionMinor: PositiveIntegerSchema.nullable(),
    requiresAdminCredentials: z.literal(false),
    fetchedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    terms: OfflineVoucherTermsSchema.omit({ code: true }),
  })
  .strict();

// ADR-042 §6.3 (verifier v2): the till receives salt + scrypt cost + a device-, admin- and version-bound HMAC
// tag of the server's ONE-WAY verifier. It re-derives the tag from the typed override password in its main
// process. The server keeps no plaintext and no recoverable (encrypted) copy of the password.
export const OfflineOverrideVerifierSchema = z
  .object({
    algorithm: z.literal("scrypt-hmac-sha256-v2"),
    saltBase64: Base64Schema,
    deviceTagBase64: Base64Schema,
    n: z.number().int().min(16384),
    r: z.number().int().min(8),
    p: z.number().int().positive(),
    keyLength: z.number().int().min(32),
  })
  .strict();

export const OfflineOverrideRosterEntrySchema = z
  .object({
    membershipId: UuidSchema,
    username: z.string().min(1),
    displayName: z.string().min(1),
    permissions: z.array(z.enum(["promotions.manage", "payments.refund"])).min(1),
    verifierVersion: PositiveIntegerSchema,
    verifier: OfflineOverrideVerifierSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

// Offline PIN v2 (20261115170000): a staff member enrolled an offline-unlock PIN on THIS device. The verifier
// exists only in the device's OS-protected store; the server sends just who is authorised right now and at which
// enrollment version. The till must hold a local verifier for exactly this enrollment id + version.
export const OfflinePinAuthorizationSchema = z
  .object({
    membershipId: UuidSchema,
    username: z.string().min(1),
    displayName: z.string().min(1),
    enrollmentId: UuidSchema,
    verifierVersion: PositiveIntegerSchema,
  })
  .strict();

// Self-enrollment of the AUTHENTICATED caller on one device of the register. Carries NO PIN: the PIN is typed
// and turned into a device-bound verifier inside the till's main process only.
/**
 * Offline PIN v2 enrollment. `stepUp` is the caller's OWN online POS sign-in (username + current sign-in
 * PIN), re-verified by the server in this request so enrollment never relies on the age of a session token.
 * It is not stored. The new OFFLINE PIN is never part of any request.
 */
export const OfflinePinStepUpSchema = z
  .object({
    username: z.string().trim().min(1).max(32),
    pin: PosPinSchema,
  })
  .strict();
export const EnrollOfflinePinRequestSchema = z
  .object({ deviceId: UuidSchema, registerId: UuidSchema, stepUp: OfflinePinStepUpSchema })
  .strict();
export const EnrollOfflinePinResponseSchema = z
  .object({
    membershipId: UuidSchema,
    deviceId: UuidSchema,
    enrollmentId: UuidSchema,
    verifierVersion: PositiveIntegerSchema,
    enrolledAt: IsoDateTimeSchema,
  })
  .strict();
export const RevokeOfflinePinEnrollmentsRequestSchema = z
  .object({
    membershipId: UuidSchema.optional(),
    deviceId: UuidSchema.optional(),
    reason: z.enum([
      "pin_forgotten",
      "device_lost",
      "user_removed",
      "key_rotation",
      "admin_revoked",
    ]),
  })
  .strict();
export const RevokeOfflinePinEnrollmentsResponseSchema = z
  .object({ revoked: NonNegativeIntegerSchema })
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
  // Present only when the server is configured for offline PINs AND at least one authorized seller on this
  // register has a PIN set. The POS reads it defensively; absence disables offline PIN unlock for the device.
  // RETIRED (20261115170000): server-minted verifiers from KEK-sealed PINs. No current server sends it.
  staffRoster: z.array(OfflineStaffRosterEntrySchema).optional(),
  // Offline PIN v2: enrollments on this device for currently-authorised sellers. Absent ⇒ offline PIN unlock
  // is unavailable on this device until someone enrols while online.
  offlinePinAuthorizations: z.array(OfflinePinAuthorizationSchema).optional(),
  // The tenant's customers with their current outstanding balance, so the till can attach installments
  // and show running tabs offline. Absent on an older server ⇒ offline installments are unavailable.
  customers: z.array(OfflineCustomerSnapshotSchema).optional(),
  // ADR-042 §4. null: the location does not use channel stock (sell offline as before). Absent on an older
  // server, which the till treats the same as null.
  stockGrant: OfflineStockGrantSchema.nullable().optional(),
  // ADR-042 §5: reserved POS quota per offline-enabled voucher. Empty/absent ⇒ no offline vouchers.
  voucherGrants: z.array(OfflineVoucherGrantSchema).optional(),
  // ADR-042 §13.6: cached policies of existing vouchers usable offline on this lease. Absent/empty ⇒ every
  // voucher is online-only (the server flag is off, or no voucher is eligible).
  voucherPolicies: z.array(OfflineVoucherPolicySchema).optional(),
  // ADR-042 §6.3: device-bound verifiers of the admins who can approve at this till. Absent ⇒ none.
  overrideRoster: z.array(OfflineOverrideRosterEntrySchema).optional(),
});

// ADR-042 §6.3: one-use admin assertion produced by the till's main process after the admin typed their POS
// username + override password. It rides inside the device-signed command; the server checks it was issued
// to this device's offline grant for that admin, permission and verifier version, binds it to this command,
// and accepts each assertionId once.
export const OfflineAdminAssertionSchema = z
  .object({
    assertionId: UuidSchema,
    adminMembershipId: UuidSchema,
    permission: z.enum(["promotions.manage", "payments.refund"]),
    verifierVersion: PositiveIntegerSchema,
    commandId: UuidSchema,
    // The bootstrap (offline grant) whose verifier the admin was checked against.
    offlineGrantId: UuidSchema,
  })
  .strict();

// ADR-042 §5 (SUPERSEDED): an offline voucher use against a reserved POS quota grant. Still accepted so an
// older till's queued sale is never lost; no grant is issued any more, so it reconciles to VX_GRANT_INVALID.
export const OfflineSaleReservedVoucherSchema = z
  .object({
    voucherGrantId: UuidSchema,
    promotionId: UuidSchema,
    codeId: UuidSchema.optional(),
    discountTotalMinor: PositiveIntegerSchema,
    adminAssertion: OfflineAdminAssertionSchema.optional(),
  })
  .strict();

// ADR-042 §13.6: an offline use of an existing voucher priced from the lease's cached policy. totalMinor is the
// NET. `observedRemaining` is the till's last-known shared remaining usage BEFORE this use (snapshot value minus
// this till's own unsynced uses; null = unlimited). Evidence only: the server decides against live shared usage.
export const OfflineSaleCachedVoucherSchema = z
  .object({
    policyIssuanceId: UuidSchema,
    promotionId: UuidSchema,
    codeId: UuidSchema,
    policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    observedRemaining: NonNegativeIntegerSchema.nullable(),
    discountTotalMinor: PositiveIntegerSchema,
  })
  .strict();

export const OfflineSaleVoucherSchema = z.union([
  OfflineSaleCachedVoucherSchema,
  OfflineSaleReservedVoucherSchema,
]);

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
    // Optional split tender. When present, the tender amounts sum to the amount settled NOW — the full
    // totalMinor for a normal sale, or amountPaidMinor (the deposit) for an installment. The cash
    // tender's cashReceived/change mirror the top-level cashReceivedMinor/changeMinor. Absent ⇒ cash-only.
    tenders: z.array(PosTenderInputSchema).min(1).max(4).optional(),
    offlineSaleOrdinal: PositiveIntegerSchema,
    cumulativeExposureMinor: NonNegativeIntegerSchema,
    // Installment fields — all-or-nothing. A normal (fully-settled) sale OMITS all three, keeping its
    // canonical form and signature byte-identical to a pre-installment client. When present, the sale
    // is an installment: amountPaidMinor is the deposit settled now (1..totalMinor-1), the remaining
    // outstandingMinor (= totalMinor - amountPaidMinor) becomes a debt owned by customerId.
    customerId: UuidSchema.optional(),
    amountPaidMinor: NonNegativeIntegerSchema.optional(),
    outstandingMinor: NonNegativeIntegerSchema.optional(),
    // ADR-042 §5. Omitted for a sale without a voucher (canonical form unchanged).
    voucher: OfflineSaleVoucherSchema.optional(),
    // ADR-043 §5.1: the person actually operating the till when the sale was accepted — the operator who
    // unlocked it offline with their own PIN (device-bound verifier), or the signed-in online operator. Set by
    // the till's main process only (never the renderer) and covered by the device signature. The server
    // verifies it against that device's PIN enrollments at acceptance time; it never changes the grant's
    // authority. Omitted by older tills (canonical form unchanged → attribution falls back to the grant
    // operator).
    unlockedByMembershipId: UuidSchema.optional(),
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
    // Installment coherence: the three fields travel together or not at all.
    const installmentKeys = ["customerId", "amountPaidMinor", "outstandingMinor"] as const;
    const present = installmentKeys.filter((key) => value[key] !== undefined);
    const isInstallment = present.length === installmentKeys.length;
    if (present.length > 0 && !isInstallment) {
      ctx.addIssue({
        code: "custom",
        path: [present[0]!],
        message: "customerId, amountPaidMinor and outstandingMinor must be provided together",
      });
    }
    if (isInstallment) {
      if (
        !(value.amountPaidMinor! >= 1 && value.amountPaidMinor! < value.totalMinor) ||
        value.outstandingMinor !== value.totalMinor - value.amountPaidMinor!
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["amountPaidMinor"],
          message:
            "deposit must be between 1 and totalMinor-1 and outstanding must be the remainder",
        });
      }
    }
    // Tenders settle the amount collected now: the deposit for an installment, else the full total.
    const settleTarget = isInstallment ? value.amountPaidMinor! : value.totalMinor;
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
      if (sum !== settleTarget)
        ctx.addIssue({
          code: "custom",
          path: ["tenders"],
          message: "tenders must sum to the amount settled now",
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

// An offline tender as the server recorded it (ADR-042 §13.3 supersedes §4.7 / Finding B's pending state).
export const OfflineTenderConfirmationSchema = z.enum([
  // ADR-042 §13.3: the POS has no payment gateway. Every tender (cash, card/Visa, InstaPay, wallet) is a
  // cashier-entered record of a transaction the cashier handled; once synced it is recorded in the server
  // ledger exactly like a connected POS tender. Nothing here claims a provider captured the money.
  "cashier_recorded",
]);
export const OfflinePosPaymentSchema = PosPaymentSchema.extend({
  status: z.enum(["captured", "pending"]),
  capturedAt: IsoDateTimeSchema.nullable(),
  confirmation: OfflineTenderConfirmationSchema,
});

export const IngestOfflineSaleResponseSchema = z.object({
  syncStatus: z.enum(["synced", "needs_reconciliation"]),
  ingestionId: UuidSchema,
  localSaleId: z.string(),
  receivedAt: IsoDateTimeSchema,
  order: PosOrderSchema,
  payment: OfflinePosPaymentSchema,
  payments: z.array(OfflinePosPaymentSchema).min(1).optional(),
  fulfillment: PosFulfillmentSchema.nullable(),
  reconciliation: OfflineReconciliationSchema.nullable(),
});

// Phase D2 — a customer paydown (installment repayment) accepted while OFFLINE and synced later. Signed
// with the same device key as offline sales and bound to the active grant; the server applies it
// idempotently through customers_ar_private.record_customer_payment keyed to syncCommandId.
export const OfflineCustomerPaymentCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    localPaymentId: z.string().trim().min(1).max(200),
    syncCommandId: UuidSchema,
    grantId: UuidSchema,
    deviceId: UuidSchema,
    registerId: UuidSchema,
    acceptedAt: IsoDateTimeSchema,
    currency: CurrencySchema,
    customerId: UuidSchema,
    amountMinor: PositiveIntegerSchema,
  })
  .strict();

export const IngestOfflineCustomerPaymentRequestSchema = z
  .object({
    command: OfflineCustomerPaymentCommandSchema,
    signature: z.object({
      algorithm: z.literal("Ed25519"),
      credentialId: UuidSchema,
      value: Base64Schema,
    }),
  })
  .strict();

// ADR-042 §13.5: a signed offline command that business state refuses at sync (paydown above the server
// outstanding; duplicate/unmatched clock event) is PRESERVED once as server evidence with a sync conflict.
// It is terminal (not retryable) and is NOT applied to the AR ledger / attendance timeline.
export const OfflineSyncConflictRefSchema = z.object({
  id: UuidSchema,
  kind: z.enum(["customer_debt", "attendance"]),
  reasonCode: z.string().min(1),
});
export const OfflineConflictRecordedResponseSchema = z.object({
  syncStatus: z.literal("conflict_recorded"),
  ingestionId: UuidSchema,
  receivedAt: IsoDateTimeSchema,
  conflict: OfflineSyncConflictRefSchema,
});

// ADR-042 §13.5 — post-sync conflict report (read-only). Report/reconciliation only: listing a conflict
// never approves, reprices or mutates the original sale/payment/customer/voucher/attendance record.
export const PosSyncConflictKindSchema = z.enum([
  "stock_shortfall",
  "voucher",
  "customer_duplicate",
  "customer_debt",
  "attendance",
  "dependency",
  "sync_integrity",
]);
export const PosSyncConflictStatusSchema = z.enum(["open", "informational"]);
export const PosSyncConflictSchema = z.object({
  id: UuidSchema,
  kind: PosSyncConflictKindSchema,
  reasonCode: z.string().min(1),
  status: PosSyncConflictStatusSchema,
  branchId: UuidSchema.nullable(),
  inventoryLocationId: UuidSchema.nullable(),
  deviceId: UuidSchema.nullable(),
  registerId: UuidSchema.nullable(),
  syncCommandId: UuidSchema.nullable(),
  localReference: z.string().nullable(),
  references: z.object({
    orderId: UuidSchema.nullable(),
    paymentId: UuidSchema.nullable(),
    customerId: UuidSchema.nullable(),
    promotionId: UuidSchema.nullable(),
    membershipId: UuidSchema.nullable(),
    variantId: UuidSchema.nullable(),
  }),
  quantity: z.number().int().nullable(),
  amountMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  localEvidence: z.record(z.string(), z.unknown()),
  serverEvidence: z.record(z.string(), z.unknown()),
  localEventAt: IsoDateTimeSchema.nullable(),
  detectedAt: IsoDateTimeSchema,
});
export const ListPosSyncConflictsQuerySchema = z.object({
  registerId: UuidSchema.optional(),
  kind: PosSyncConflictKindSchema.optional(),
  status: PosSyncConflictStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const ListPosSyncConflictsResponseSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  summary: z.object({
    open: NonNegativeIntegerSchema,
    informational: NonNegativeIntegerSchema,
  }),
  items: z.array(PosSyncConflictSchema),
});

export const AppliedOfflineCustomerPaymentResponseSchema = z.object({
  syncStatus: z.literal("synced"),
  ingestionId: UuidSchema,
  localPaymentId: z.string(),
  receivedAt: IsoDateTimeSchema,
  payment: z.object({
    id: UuidSchema,
    customerId: UuidSchema,
    currency: CurrencySchema,
    amountMinor: NonNegativeIntegerSchema,
    paidAt: IsoDateTimeSchema,
    outstandingMinor: NonNegativeIntegerSchema,
  }),
});
export const IngestOfflineCustomerPaymentResponseSchema = z.discriminatedUnion("syncStatus", [
  AppliedOfflineCustomerPaymentResponseSchema,
  OfflineConflictRecordedResponseSchema.extend({ localPaymentId: z.string() }),
]);

// Phase 9 (Decision C) — an attendance clock event (clock-in / clock-out) captured while OFFLINE and
// synced later. Signed with the same device key as offline sales and bound to the active grant. It is
// APPEND-ONLY and PROVISIONAL: the server records an immutable, auditable received event keyed to
// syncCommandId; it does NOT compute payroll, shift attribution, grace periods or rounding, and it does
// not mutate prior events. `eventType` is the operator's clock action; `eventAt` is the device-clock
// time evidence available from the lease model (bounded by the acceptedAt skew window at ingestion).
export const OfflineAttendanceEventTypeSchema = z.enum(["clock_in", "clock_out"]);

export const OfflineAttendanceCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    localEventId: z.string().trim().min(1).max(200),
    syncCommandId: UuidSchema,
    grantId: UuidSchema,
    deviceId: UuidSchema,
    registerId: UuidSchema,
    // The offline-PIN roster operator who clocked (Decision C-i recommendation). Attribution to a
    // payroll subject beyond this authenticated identity remains an open owner policy decision.
    operatorMembershipId: UuidSchema,
    // Team clock target. Omitted by older tills, where the operator clocks themselves.
    membershipId: UuidSchema.optional(),
    eventType: OfflineAttendanceEventTypeSchema,
    // Trustworthy device-clock time of the clock action. Bounded against the grant/skew window server-side.
    eventAt: IsoDateTimeSchema,
    // When the command was accepted on the device (for the same ±skew authority check as offline sales).
    acceptedAt: IsoDateTimeSchema,
  })
  .strict();

export const IngestOfflineAttendanceRequestSchema = z
  .object({
    command: OfflineAttendanceCommandSchema,
    signature: z.object({
      algorithm: z.literal("Ed25519"),
      credentialId: UuidSchema,
      value: Base64Schema,
    }),
  })
  .strict();

export const AppliedOfflineAttendanceResponseSchema = z.object({
  // "received" — the event is durably stored and awaiting policy adjudication; it is explicitly NOT
  // "synced as final payroll attendance". The client shows it as server-received, not canonical.
  syncStatus: z.literal("received"),
  ingestionId: UuidSchema,
  localEventId: z.string(),
  receivedAt: IsoDateTimeSchema,
  event: z.object({
    membershipId: UuidSchema,
    eventType: OfflineAttendanceEventTypeSchema,
    eventAt: IsoDateTimeSchema,
    // Adjudication state so the UI never implies payroll finality. Always "pending_policy" in V1.
    adjudication: z.enum(["pending_policy", "applied"]),
  }),
});
export const IngestOfflineAttendanceResponseSchema = z.discriminatedUnion("syncStatus", [
  AppliedOfflineAttendanceResponseSchema,
  OfflineConflictRecordedResponseSchema.extend({ localEventId: z.string() }),
]);

// Phase 5 (Decision A) — offline returns. While ONLINE the server issues a bounded, per-order return grant
// that FREEZES returns_private.return_eligibility (server-authoritative per-line eligible quantities + the
// net-basis refund ceiling). Later, OFFLINE, the till signs a return command referencing that grant. The
// server recomputes the NET refund (never the client), creates a Return + refund with status PENDING
// (settlement WITHHELD — no cash handed, no provider capture offline), and does NOT post canonical stock at
// ingestion (every line is accepted as non_restock; physical receipt is held for connected inspection).
// Eligibility drift since issuance, or a revoked device, yields needs_reconciliation with no canonical return.

export const OfflineReturnGrantLineSchema = z
  .object({
    orderLineId: UuidSchema,
    lineNumber: NonNegativeIntegerSchema,
    variantId: UuidSchema,
    // Server-authoritative remaining-eligible quantity, frozen at grant issuance.
    eligibleQuantity: NonNegativeIntegerSchema,
    unitPriceMinor: NonNegativeIntegerSchema,
  })
  .strict();

export const IssueOfflineReturnGrantRequestSchema = z
  .object({
    deviceId: UuidSchema,
    registerId: UuidSchema,
    orderId: UuidSchema,
  })
  .strict();

// ADR-042 §8: a new customer captured offline (name + phone). localCustomerId becomes the server id.
export const OfflineCustomerCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    syncCommandId: UuidSchema,
    localCustomerId: UuidSchema,
    grantId: UuidSchema,
    deviceId: UuidSchema,
    registerId: UuidSchema,
    acceptedAt: IsoDateTimeSchema,
    name: z.string().trim().min(1).max(200),
    phone: z.string().trim().min(7).max(32),
  })
  .strict();

export const IngestOfflineCustomerRequestSchema = z
  .object({
    command: OfflineCustomerCommandSchema,
    signature: z.object({
      algorithm: z.literal("Ed25519"),
      credentialId: UuidSchema,
      value: Base64Schema,
    }),
  })
  .strict();

export const IngestOfflineCustomerResponseSchema = z.object({
  ingestionId: UuidSchema,
  localCustomerId: UuidSchema,
  customerId: UuidSchema,
  // Another customer already has this phone. Flagged only; never merged.
  duplicateOfCustomerId: UuidSchema.nullable(),
  receivedAt: IsoDateTimeSchema,
});

// ADR-042 §4.6 (Finding A): terminal disposition of an offline sale the till cannot send because the new
// customer it depends on was definitively rejected. The device signs this hold over the ORIGINAL signed
// sale's fingerprint; the server records the ordinal as held_for_reconciliation (sale not applied, not
// voided, units stay reserved) so the stock grant can close. Exact replay returns the original receipt.
export const OfflineSaleHoldReasonSchema = z.enum(["customer_dependency_rejected"]);
export const OfflineSaleHoldCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    syncCommandId: UuidSchema,
    saleSyncCommandId: UuidSchema,
    saleCommandFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    grantId: UuidSchema,
    deviceId: UuidSchema,
    registerId: UuidSchema,
    localSaleId: z.string().trim().min(1).max(200),
    offlineSaleOrdinal: PositiveIntegerSchema,
    customerId: UuidSchema,
    reason: OfflineSaleHoldReasonSchema,
    requestedAt: IsoDateTimeSchema,
  })
  .strict();

export const IngestOfflineSaleHoldRequestSchema = z
  .object({
    command: OfflineSaleHoldCommandSchema,
    signature: z.object({
      algorithm: z.literal("Ed25519"),
      credentialId: UuidSchema,
      value: Base64Schema,
    }),
    // The original signed sale, byte-for-byte as the till signed it at acceptance.
    sale: IngestOfflineSaleRequestSchema,
  })
  .strict();

export const IngestOfflineSaleHoldResponseSchema = z.object({
  holdId: UuidSchema,
  saleSyncCommandId: UuidSchema,
  offlineSaleOrdinal: PositiveIntegerSchema,
  status: z.literal("held_for_reconciliation"),
  heldLines: z.array(
    z.object({
      variantId: UuidSchema,
      quantity: PositiveIntegerSchema,
      requestedQuantity: PositiveIntegerSchema,
    }),
  ),
  receivedAt: IsoDateTimeSchema,
});

// ADR-042 §6.3 / D-6: set MY OWN POS override password (re-authenticated with my POS username + PIN).
export const SetPosOverridePasswordRequestSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    pin: PosPinSchema,
    password: z.string().min(10).max(128),
  })
  .strict();

export const PosOverridePasswordResponseSchema = z.object({
  membershipId: UuidSchema,
  verifierVersion: PositiveIntegerSchema,
  updatedAt: IsoDateTimeSchema,
  cleared: z.boolean().optional(),
});

export const OfflineReturnGrantResponseSchema = z.object({
  returnGrantId: UuidSchema,
  snapshotId: UuidSchema,
  schemaVersion: z.literal(1),
  minimumClientVersion: z.string(),
  tenantId: UuidSchema,
  deviceId: UuidSchema,
  registerId: UuidSchema,
  branchId: UuidSchema,
  inventoryLocationId: UuidSchema,
  operatorMembershipId: UuidSchema,
  orderId: UuidSchema,
  currency: CurrencySchema,
  issuedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  // min(canonical ceiling, the owner's per-grant offline refund budget) frozen at issuance (ADR-042 D-7).
  maxRefundableMinor: NonNegativeIntegerSchema,
  // ADR-042 §6/§7: each return under this grant needs a one-use admin (payments.refund) assertion.
  requiresAdminCredentials: z.boolean(),
  // Server return policy allowed reasons, if the tenant restricts them; null ⇒ any non-empty reason.
  allowedReasons: z.array(z.string()).nullable(),
  lines: z.array(OfflineReturnGrantLineSchema),
});

export const OfflineReturnCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    localReturnId: z.string().trim().min(1).max(200),
    syncCommandId: UuidSchema,
    returnGrantId: UuidSchema,
    deviceId: UuidSchema,
    registerId: UuidSchema,
    orderId: UuidSchema,
    acceptedAt: IsoDateTimeSchema,
    currency: CurrencySchema,
    lines: z
      .array(
        z
          .object({
            orderLineId: UuidSchema,
            quantity: PositiveIntegerSchema,
            reason: z.string().trim().min(1).max(500),
            // Operator's intended disposition. The server forces non_restock at ingestion (stock not posted
            // offline) but preserves this intent in provenance for a later connected inspection/restock.
            disposition: z.enum(["restock", "non_restock"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    // ADR-042 §6/§7: required when the return grant says requiresAdminCredentials.
    adminAssertion: OfflineAdminAssertionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const lines = new Set<string>();
    for (const [index, line] of value.lines.entries()) {
      if (lines.has(line.orderLineId))
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "orderLineId"],
          message: "an order line may appear at most once",
        });
      lines.add(line.orderLineId);
    }
  });

export const IngestOfflineReturnRequestSchema = z
  .object({
    command: OfflineReturnCommandSchema,
    signature: z.object({
      algorithm: z.literal("Ed25519"),
      credentialId: UuidSchema,
      value: Base64Schema,
    }),
  })
  .strict();

export const OfflineReturnReconciliationSchema = z.object({
  id: UuidSchema,
  reason: z.enum([
    "eligibility_drift_at_ingestion",
    "device_revoked_at_ingestion",
    "admin_credential_invalid_at_ingestion",
    "refund_budget_exceeded_at_ingestion",
  ]),
  status: z.literal("open"),
});

export const IngestOfflineReturnResponseSchema = z.object({
  syncStatus: z.enum(["synced", "needs_reconciliation"]),
  ingestionId: UuidSchema,
  localReturnId: z.string(),
  receivedAt: IsoDateTimeSchema,
  // The canonical Return when accepted; null when held for reconciliation.
  returnId: UuidSchema.nullable(),
  // The withheld refund. status is ALWAYS "pending" offline — settlement happens only via the connected
  // attestation path after reconnect. Null when held for reconciliation.
  refund: z
    .object({
      id: UuidSchema,
      status: z.literal("pending"),
      amountMinor: NonNegativeIntegerSchema,
      currency: CurrencySchema,
    })
    .nullable(),
  reconciliation: OfflineReturnReconciliationSchema.nullable(),
});

// ---- POS-native (pos_pin) authentication (ADR-040) ----------------------------------------------------
// The PIN rule is `PosPinSchema` (top of file, ADR-043: digits, min 4, no product max). Login accepts a
// loosely-bounded username (the server lowercases + resolves it); provisioning enforces the strict format.
const PosLoginUsernameSchema = z.string().trim().min(1).max(64);
const PosProvisionUsernameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,30}$/);
export const PosOperatorRoleSchema = z.enum(["admin", "cashier"]);
// Section ids a cashier may open in the POS shell. Free-form on the wire (the client owns the section set);
// bounded so the array cannot become unbounded storage.
const PosPermissionsSchema = z.array(z.string().min(1).max(64)).max(64);

/** Public connected sign-in: username + PIN. No tenant/device — the server resolves the tenant. */
export const PosLoginRequestSchema = z
  .object({ username: PosLoginUsernameSchema, pin: PosPinSchema })
  .strict();

/** The operator the POS renders after sign-in; `role`/`permissions` shape the sidebar (not API access). */
export const PosOperatorSchema = z
  .object({
    membershipId: UuidSchema,
    tenantId: UuidSchema,
    username: z.string().min(1),
    displayName: z.string().min(1),
    role: PosOperatorRoleSchema,
    permissions: z.array(z.string()),
  })
  .strict();

export const PosLoginResponseSchema = z
  .object({
    accessToken: z.string().min(1),
    expiresAt: IsoDateTimeSchema,
    operator: PosOperatorSchema,
  })
  .strict();

/** Admin provisioning of a pos_pin account. RBAC role/scope still govern API access; posRole/posPermissions
 * shape the POS UI. */
export const CreatePosLoginRequestSchema = z
  .object({
    username: PosProvisionUsernameSchema,
    pin: PosPinSchema,
    displayName: z.string().trim().min(1).max(120),
    roleId: UuidSchema,
    accessScopeId: UuidSchema,
    posRole: PosOperatorRoleSchema,
    posPermissions: PosPermissionsSchema.default([]),
  })
  .strict();

export const UpdatePosLoginRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    posRole: PosOperatorRoleSchema,
    posPermissions: PosPermissionsSchema.default([]),
  })
  .strict();

export const SetPosLoginPinRequestSchema = z.object({ pin: PosPinSchema }).strict();

export const SetPosLoginPinResponseSchema = z
  .object({ membershipId: UuidSchema, updatedAt: IsoDateTimeSchema })
  .strict();

export const PosLoginSummarySchema = z
  .object({
    membershipId: UuidSchema,
    username: z.string().min(1),
    displayName: z.string().nullable(),
    status: z.enum(["invited", "active", "suspended", "deactivated"]),
    posRole: PosOperatorRoleSchema,
    posPermissions: z.array(z.string()),
  })
  .strict();

export const PosLoginListResponseSchema = z
  .object({ items: z.array(PosLoginSummarySchema) })
  .strict();

export type PosLoginRequest = z.infer<typeof PosLoginRequestSchema>;
export type PosOperator = z.infer<typeof PosOperatorSchema>;
export type PosLoginResponse = z.infer<typeof PosLoginResponseSchema>;
export type CreatePosLoginRequest = z.infer<typeof CreatePosLoginRequestSchema>;
export type UpdatePosLoginRequest = z.infer<typeof UpdatePosLoginRequestSchema>;
export type SetPosLoginPinRequest = z.infer<typeof SetPosLoginPinRequestSchema>;
export type SetPosLoginPinResponse = z.infer<typeof SetPosLoginPinResponseSchema>;
export type PosLoginSummary = z.infer<typeof PosLoginSummarySchema>;
export type PosLoginListResponse = z.infer<typeof PosLoginListResponseSchema>;

export type PosTenderMethod = z.infer<typeof PosTenderMethodSchema>;
export type PosTenderInput = z.infer<typeof PosTenderInputSchema>;
export type PosPayment = z.infer<typeof PosPaymentSchema>;
export type PosContextResponse = z.infer<typeof PosContextResponseSchema>;
export type PosAvailabilityResponse = z.infer<typeof PosAvailabilityResponseSchema>;
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
export type OfflineCustomerSnapshot = z.infer<typeof OfflineCustomerSnapshotSchema>;
export type OfflineCustomerPaymentCommand = z.infer<typeof OfflineCustomerPaymentCommandSchema>;
export type IngestOfflineCustomerPaymentRequest = z.infer<
  typeof IngestOfflineCustomerPaymentRequestSchema
>;
export type IngestOfflineCustomerPaymentResponse = z.infer<
  typeof IngestOfflineCustomerPaymentResponseSchema
>;
export type OfflineAttendanceEventType = z.infer<typeof OfflineAttendanceEventTypeSchema>;
export type OfflineAttendanceCommand = z.infer<typeof OfflineAttendanceCommandSchema>;
export type IngestOfflineAttendanceRequest = z.infer<typeof IngestOfflineAttendanceRequestSchema>;
export type IngestOfflineAttendanceResponse = z.infer<typeof IngestOfflineAttendanceResponseSchema>;
export type PosSyncConflict = z.infer<typeof PosSyncConflictSchema>;
export type PosSyncConflictKind = z.infer<typeof PosSyncConflictKindSchema>;
export type ListPosSyncConflictsQuery = z.infer<typeof ListPosSyncConflictsQuerySchema>;
export type ListPosSyncConflictsResponse = z.infer<typeof ListPosSyncConflictsResponseSchema>;
export type OfflineBootstrapRequest = z.infer<typeof OfflineBootstrapRequestSchema>;
export type OfflineBootstrapResponse = z.infer<typeof OfflineBootstrapResponseSchema>;
export type OfflineStockGrant = z.infer<typeof OfflineStockGrantSchema>;
export type OfflineVoucherGrant = z.infer<typeof OfflineVoucherGrantSchema>;
export type OfflineVoucherTerms = z.infer<typeof OfflineVoucherTermsSchema>;
export type OfflineOverrideRosterEntry = z.infer<typeof OfflineOverrideRosterEntrySchema>;
export type OfflineAdminAssertion = z.infer<typeof OfflineAdminAssertionSchema>;
export type OfflineSaleVoucher = z.infer<typeof OfflineSaleVoucherSchema>;
export type OfflinePinAuthorization = z.infer<typeof OfflinePinAuthorizationSchema>;
export type EnrollOfflinePinRequest = z.infer<typeof EnrollOfflinePinRequestSchema>;
export type EnrollOfflinePinResponse = z.infer<typeof EnrollOfflinePinResponseSchema>;
export type RevokeOfflinePinEnrollmentsRequest = z.infer<
  typeof RevokeOfflinePinEnrollmentsRequestSchema
>;
export type RevokeOfflinePinEnrollmentsResponse = z.infer<
  typeof RevokeOfflinePinEnrollmentsResponseSchema
>;
export type OfflineVoucherPolicy = z.infer<typeof OfflineVoucherPolicySchema>;
export type OfflineSaleCachedVoucher = z.infer<typeof OfflineSaleCachedVoucherSchema>;
export type OfflineCustomerCommand = z.infer<typeof OfflineCustomerCommandSchema>;
export type IngestOfflineCustomerRequest = z.infer<typeof IngestOfflineCustomerRequestSchema>;
export type IngestOfflineCustomerResponse = z.infer<typeof IngestOfflineCustomerResponseSchema>;
export type OfflinePosPayment = z.infer<typeof OfflinePosPaymentSchema>;
export type OfflineTenderConfirmation = z.infer<typeof OfflineTenderConfirmationSchema>;
export type OfflineSaleHoldCommand = z.infer<typeof OfflineSaleHoldCommandSchema>;
export type IngestOfflineSaleHoldRequest = z.infer<typeof IngestOfflineSaleHoldRequestSchema>;
export type IngestOfflineSaleHoldResponse = z.infer<typeof IngestOfflineSaleHoldResponseSchema>;
export type SetPosOverridePasswordRequest = z.infer<typeof SetPosOverridePasswordRequestSchema>;
export type PosOverridePasswordResponse = z.infer<typeof PosOverridePasswordResponseSchema>;
export type StaffPinVerifier = z.infer<typeof StaffPinVerifierSchema>;
export type OfflineStaffRosterEntry = z.infer<typeof OfflineStaffRosterEntrySchema>;
export type SetStaffOfflinePinRequest = z.infer<typeof SetStaffOfflinePinRequestSchema>;
export type SetStaffOfflinePinResponse = z.infer<typeof SetStaffOfflinePinResponseSchema>;
export type OfflineSaleCommand = z.infer<typeof OfflineSaleCommandSchema>;
export type IngestOfflineSaleRequest = z.infer<typeof IngestOfflineSaleRequestSchema>;
export type IngestOfflineSaleResponse = z.infer<typeof IngestOfflineSaleResponseSchema>;
export type OfflineReturnGrantLine = z.infer<typeof OfflineReturnGrantLineSchema>;
export type IssueOfflineReturnGrantRequest = z.infer<typeof IssueOfflineReturnGrantRequestSchema>;
export type OfflineReturnGrantResponse = z.infer<typeof OfflineReturnGrantResponseSchema>;
export type OfflineReturnCommand = z.infer<typeof OfflineReturnCommandSchema>;
export type IngestOfflineReturnRequest = z.infer<typeof IngestOfflineReturnRequestSchema>;
export type OfflineReturnReconciliation = z.infer<typeof OfflineReturnReconciliationSchema>;
export type IngestOfflineReturnResponse = z.infer<typeof IngestOfflineReturnResponseSchema>;
export type OfflineIntentOperation = z.infer<typeof OfflineIntentOperationSchema>;
export type OfflineIntentCommand = z.infer<typeof OfflineIntentCommandSchema>;
export type IngestOfflineIntentRequest = z.infer<typeof IngestOfflineIntentRequestSchema>;
export type IngestOfflineIntentResponse = z.infer<typeof IngestOfflineIntentResponseSchema>;
export type OfflineIntentDisposition = z.infer<typeof OfflineIntentDispositionSchema>;
