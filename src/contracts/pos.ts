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
  .object({ deviceId: UuidSchema, registerId: UuidSchema })
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
// A numeric till PIN of 4–12 digits; the server seals it and never returns it.
export const SetStaffOfflinePinRequestSchema = z
  .object({ pin: z.string().regex(/^[0-9]{4,12}$/) })
  .strict();

export const SetStaffOfflinePinResponseSchema = z
  .object({
    membershipId: UuidSchema,
    keyVersion: z.number().int().positive(),
    updatedAt: IsoDateTimeSchema,
  })
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
  staffRoster: z.array(OfflineStaffRosterEntrySchema).optional(),
  // The tenant's customers with their current outstanding balance, so the till can attach installments
  // and show running tabs offline. Absent on an older server ⇒ offline installments are unavailable.
  customers: z.array(OfflineCustomerSnapshotSchema).optional(),
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

export const IngestOfflineCustomerPaymentResponseSchema = z.object({
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

export const IngestOfflineAttendanceResponseSchema = z.object({
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
    adjudication: z.literal("pending_policy"),
  }),
});

// ---- POS-native (pos_pin) authentication (ADR-040) ----------------------------------------------------
// A numeric PIN of 4–12 digits (the offline credential uses the same shape). Login accepts a loosely-bounded
// username (the server lowercases + resolves it); provisioning enforces the strict instance-global format.
const PosPinSchema = z.string().regex(/^[0-9]{4,12}$/);
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
export type OfflineBootstrapRequest = z.infer<typeof OfflineBootstrapRequestSchema>;
export type OfflineBootstrapResponse = z.infer<typeof OfflineBootstrapResponseSchema>;
export type StaffPinVerifier = z.infer<typeof StaffPinVerifierSchema>;
export type OfflineStaffRosterEntry = z.infer<typeof OfflineStaffRosterEntrySchema>;
export type SetStaffOfflinePinRequest = z.infer<typeof SetStaffOfflinePinRequestSchema>;
export type SetStaffOfflinePinResponse = z.infer<typeof SetStaffOfflinePinResponseSchema>;
export type OfflineSaleCommand = z.infer<typeof OfflineSaleCommandSchema>;
export type IngestOfflineSaleRequest = z.infer<typeof IngestOfflineSaleRequestSchema>;
export type IngestOfflineSaleResponse = z.infer<typeof IngestOfflineSaleResponseSchema>;
