import { z } from "zod";
import { paginated } from "../common/pagination";
import { CurrencySchema } from "../common/serialization";

/**
 * Operational-settings DTOs (Phase 2R-A). These expose the EXISTING organization/config tables through a
 * hardened management surface; they are not a generic settings engine. Frozen domain distinctions are
 * preserved in the types: Tenant != Brand, Branch != Warehouse, InventoryLocation != Register,
 * Device != Register. Mutation safety (immutable identifiers/parents, currency locks, lifecycle-only
 * deletion) is enforced server-side — the request schemas simply omit the fields that must never change.
 */

const Uuid = z.uuid();
const Timestamp = z.string().datetime({ offset: true });
const NullableTimestamp = z.string().datetime({ offset: true }).nullable();
const nz = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => nz(max).nullable().optional();
const CountryCode = z.string().regex(/^[A-Z]{2}$/);
export const LifecycleStatusSchema = z.enum(["active", "inactive", "archived"]);

// ============================================================================================
// Business (Tenant). slug/status are read-only; default_currency is currency-locked once orders exist.
// ============================================================================================
export const BusinessSettingsSchema = z.object({
  id: Uuid,
  slug: z.string(),
  normalizedSlug: z.string(),
  displayName: z.string(),
  legalName: z.string().nullable(),
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
  onboardingState: z.string(),
  defaultLocale: z.string(),
  defaultTimezone: z.string(),
  defaultCurrency: CurrencySchema,
  countryCode: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  taxIdentifier: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const UpdateBusinessRequestSchema = z
  .object({
    displayName: nz(200),
    legalName: optText(200),
    contactEmail: z.email().max(254).nullable().optional(),
    contactPhone: optText(50),
    defaultTimezone: nz(100),
    countryCode: CountryCode.nullable().optional(),
    taxIdentifier: optText(100),
    defaultCurrency: CurrencySchema,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");

// ============================================================================================
// Brand. code required at creation, immutable after.
// ============================================================================================
export const BrandSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  code: z.string(),
  displayName: z.string(),
  legalName: z.string().nullable(),
  status: LifecycleStatusSchema,
  archivedAt: NullableTimestamp,
  archiveReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const CreateBrandRequestSchema = z
  .object({ code: nz(100), displayName: nz(200), legalName: optText(200) })
  .strict();
export const UpdateBrandRequestSchema = z
  .object({
    displayName: nz(200),
    legalName: optText(200),
    status: LifecycleStatusSchema,
    archiveReason: optText(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");
export const BrandListResponseSchema = paginated(BrandSchema);

// ============================================================================================
// Branch (retail/business location; never a warehouse). code immutable; default location must belong
// to the branch. eligibleBrandIds is the branch<->brand operating eligibility set (never ownership).
// ============================================================================================
const branchAddress = {
  addressLine1: optText(200),
  addressLine2: optText(200),
  city: optText(120),
  region: optText(120),
  postalCode: optText(40),
  countryCode: CountryCode.nullable().optional(),
  contactEmail: z.email().max(254).nullable().optional(),
  contactPhone: optText(50),
};
export const BranchSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  code: z.string(),
  displayName: z.string(),
  timezone: z.string(),
  status: LifecycleStatusSchema,
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  isFulfillmentEnabled: z.boolean(),
  isClickAndCollectEnabled: z.boolean(),
  defaultInventoryLocationId: Uuid.nullable(),
  receiptFooter: z.string().nullable(),
  archivedAt: NullableTimestamp,
  archiveReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  eligibleBrandIds: z.array(Uuid),
});
export const CreateBranchRequestSchema = z
  .object({
    code: nz(100),
    displayName: nz(200),
    timezone: nz(100),
    ...branchAddress,
    isFulfillmentEnabled: z.boolean().optional(),
    isClickAndCollectEnabled: z.boolean().optional(),
    receiptFooter: optText(2000),
  })
  .strict();
export const UpdateBranchRequestSchema = z
  .object({
    displayName: nz(200),
    timezone: nz(100),
    ...branchAddress,
    isFulfillmentEnabled: z.boolean(),
    isClickAndCollectEnabled: z.boolean(),
    defaultInventoryLocationId: Uuid.nullable(),
    receiptFooter: optText(2000),
    status: LifecycleStatusSchema,
    archiveReason: optText(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");
export const SetBranchBrandsRequestSchema = z.object({ brandIds: z.array(Uuid) }).strict();
export const BranchListResponseSchema = paginated(BranchSchema);

// ============================================================================================
// Warehouse (stock-holding facility; never a branch). code immutable.
// ============================================================================================
const warehouseFlags = {
  isFulfillmentEnabled: z.boolean(),
  isReceivingEnabled: z.boolean(),
  isTransferOriginEnabled: z.boolean(),
  isTransferDestinationEnabled: z.boolean(),
};
export const WarehouseSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  code: z.string(),
  displayName: z.string(),
  timezone: z.string(),
  status: LifecycleStatusSchema,
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  isFulfillmentEnabled: z.boolean(),
  isReceivingEnabled: z.boolean(),
  isTransferOriginEnabled: z.boolean(),
  isTransferDestinationEnabled: z.boolean(),
  archivedAt: NullableTimestamp,
  archiveReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const CreateWarehouseRequestSchema = z
  .object({
    code: nz(100),
    displayName: nz(200),
    timezone: nz(100),
    ...branchAddress,
    isFulfillmentEnabled: z.boolean().optional(),
    isReceivingEnabled: z.boolean().optional(),
    isTransferOriginEnabled: z.boolean().optional(),
    isTransferDestinationEnabled: z.boolean().optional(),
  })
  .strict();
export const UpdateWarehouseRequestSchema = z
  .object({
    displayName: nz(200),
    timezone: nz(100),
    ...branchAddress,
    ...warehouseFlags,
    status: LifecycleStatusSchema,
    archiveReason: optText(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");
export const WarehouseListResponseSchema = paginated(WarehouseSchema);

// ============================================================================================
// Inventory location. Exactly one parent (branch XOR warehouse); parent + location_type + code are
// immutable after creation (never re-parented). Capability flags are future-operation guidance.
// ============================================================================================
const locationFlags = {
  isSellable: z.boolean(),
  isFulfillmentEnabled: z.boolean(),
  isReceivingEnabled: z.boolean(),
  isTransferOriginEnabled: z.boolean(),
  isTransferDestinationEnabled: z.boolean(),
};
export const InventoryLocationSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  branchId: Uuid.nullable(),
  warehouseId: Uuid.nullable(),
  code: z.string(),
  displayName: z.string(),
  locationType: z.string(),
  status: LifecycleStatusSchema,
  isSellable: z.boolean(),
  isFulfillmentEnabled: z.boolean(),
  isReceivingEnabled: z.boolean(),
  isTransferOriginEnabled: z.boolean(),
  isTransferDestinationEnabled: z.boolean(),
  archivedAt: NullableTimestamp,
  archiveReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const CreateInventoryLocationRequestSchema = z
  .object({
    branchId: Uuid.optional(),
    warehouseId: Uuid.optional(),
    code: nz(100),
    displayName: nz(200),
    locationType: nz(60),
    isSellable: z.boolean().optional(),
    isFulfillmentEnabled: z.boolean().optional(),
    isReceivingEnabled: z.boolean().optional(),
    isTransferOriginEnabled: z.boolean().optional(),
    isTransferDestinationEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => (v.branchId === undefined) !== (v.warehouseId === undefined),
    "Exactly one of branchId or warehouseId is required.",
  );
export const UpdateInventoryLocationRequestSchema = z
  .object({
    displayName: nz(200),
    ...locationFlags,
    status: LifecycleStatusSchema,
    archiveReason: optText(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");
export const InventoryLocationListResponseSchema = paginated(InventoryLocationSchema);

// ============================================================================================
// Register (checkout context; never an InventoryLocation). branch_id + code immutable; selling_currency
// currency-locked once the register has a POS order; active requires a valid default location.
// ============================================================================================
export const RegisterSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  branchId: Uuid,
  code: z.string(),
  displayName: z.string(),
  status: LifecycleStatusSchema,
  defaultInventoryLocationId: Uuid.nullable(),
  sellingCurrency: CurrencySchema,
  archivedAt: NullableTimestamp,
  archiveReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const CreateRegisterRequestSchema = z
  .object({
    branchId: Uuid,
    code: nz(100),
    displayName: nz(200),
    defaultInventoryLocationId: Uuid.nullable().optional(),
    sellingCurrency: CurrencySchema,
    status: LifecycleStatusSchema.optional(),
  })
  .strict();
export const UpdateRegisterRequestSchema = z
  .object({
    displayName: nz(200),
    defaultInventoryLocationId: Uuid.nullable(),
    sellingCurrency: CurrencySchema,
    status: LifecycleStatusSchema,
    archiveReason: optText(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");
export const RegisterListResponseSchema = paginated(RegisterSchema);

// ============================================================================================
// Storefront checkout settings (per brand). currency-locked once the brand has an ONLINE order.
// ============================================================================================
export const StorefrontSettingsSchema = z.object({
  tenantId: Uuid,
  brandId: Uuid,
  inventoryLocationId: Uuid,
  currency: CurrencySchema,
  codEnabled: z.boolean(),
});
export const UpsertStorefrontSettingsRequestSchema = z
  .object({
    inventoryLocationId: Uuid,
    currency: CurrencySchema,
    codEnabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");
export const StorefrontSettingsListResponseSchema = z.object({
  items: z.array(StorefrontSettingsSchema),
});

// ============================================================================================
// Return settings (per tenant). Hard integrity ceilings are enforced by the database.
// ============================================================================================
export const ReturnSettingsSchema = z.object({
  tenantId: Uuid,
  enabled: z.boolean(),
  windowDays: z.number().int().min(0).max(3650).nullable(),
  allowedReasons: z.array(z.string()),
  manualRefundsEnabled: z.boolean(),
  maxManualRefundMinor: z.number().int().min(0).nullable(),
});
export const UpdateReturnSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    windowDays: z.number().int().min(0).max(3650).nullable(),
    manualRefundsEnabled: z.boolean(),
    maxManualRefundMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    allowedReasons: z.array(z.string().trim().min(1).max(200)).max(50),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");

// ============================================================================================
// Device governance. NO private-key/credential material is ever exposed. Admin may list/revoke and
// manage the append-only register/device assignment intervals; enrollment/rotation stay device-side.
// ============================================================================================
export const DeviceAssignmentSchema = z.object({
  assignmentId: Uuid,
  registerId: Uuid,
  registerName: z.string(),
  assignedAt: Timestamp,
});
export const DeviceSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  installationId: z.string(),
  deviceType: z.string(),
  displayName: z.string(),
  status: z.enum(["enrolled", "active", "revoked"]),
  clientVersion: z.string().nullable(),
  platform: z.string().nullable(),
  osVersion: z.string().nullable(),
  activatedAt: NullableTimestamp,
  revokedAt: NullableTimestamp,
  revocationReason: z.string().nullable(),
  lastSeenAt: NullableTimestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  currentAssignment: DeviceAssignmentSchema.nullable(),
});
export const DeviceListResponseSchema = paginated(DeviceSchema);
export const RevokeDeviceRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(500).nullable().optional() })
  .strict();
export const AssignDeviceRequestSchema = z
  .object({
    registerId: Uuid,
    reason: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();

export type BusinessSettings = z.infer<typeof BusinessSettingsSchema>;
export type UpdateBusinessRequest = z.infer<typeof UpdateBusinessRequestSchema>;
export type Brand = z.infer<typeof BrandSchema>;
export type CreateBrandRequest = z.infer<typeof CreateBrandRequestSchema>;
export type UpdateBrandRequest = z.infer<typeof UpdateBrandRequestSchema>;
export type BrandListResponse = z.infer<typeof BrandListResponseSchema>;
export type Branch = z.infer<typeof BranchSchema>;
export type CreateBranchRequest = z.infer<typeof CreateBranchRequestSchema>;
export type UpdateBranchRequest = z.infer<typeof UpdateBranchRequestSchema>;
export type SetBranchBrandsRequest = z.infer<typeof SetBranchBrandsRequestSchema>;
export type BranchListResponse = z.infer<typeof BranchListResponseSchema>;
export type Warehouse = z.infer<typeof WarehouseSchema>;
export type CreateWarehouseRequest = z.infer<typeof CreateWarehouseRequestSchema>;
export type UpdateWarehouseRequest = z.infer<typeof UpdateWarehouseRequestSchema>;
export type WarehouseListResponse = z.infer<typeof WarehouseListResponseSchema>;
export type InventoryLocation = z.infer<typeof InventoryLocationSchema>;
export type CreateInventoryLocationRequest = z.infer<typeof CreateInventoryLocationRequestSchema>;
export type UpdateInventoryLocationRequest = z.infer<typeof UpdateInventoryLocationRequestSchema>;
export type InventoryLocationListResponse = z.infer<typeof InventoryLocationListResponseSchema>;
export type Register = z.infer<typeof RegisterSchema>;
export type CreateRegisterRequest = z.infer<typeof CreateRegisterRequestSchema>;
export type UpdateRegisterRequest = z.infer<typeof UpdateRegisterRequestSchema>;
export type RegisterListResponse = z.infer<typeof RegisterListResponseSchema>;
export type StorefrontSettings = z.infer<typeof StorefrontSettingsSchema>;
export type UpsertStorefrontSettingsRequest = z.infer<typeof UpsertStorefrontSettingsRequestSchema>;
export type StorefrontSettingsListResponse = z.infer<typeof StorefrontSettingsListResponseSchema>;
export type ReturnSettings = z.infer<typeof ReturnSettingsSchema>;
export type UpdateReturnSettingsRequest = z.infer<typeof UpdateReturnSettingsRequestSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequestSchema>;
export type AssignDeviceRequest = z.infer<typeof AssignDeviceRequestSchema>;
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;
