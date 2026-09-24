import { z } from "zod";

/**
 * Identity bootstrap and permission-context DTOs.
 *
 * GET /me/tenants is an identity-scoped bootstrap: it returns only the verified caller's own active
 * memberships and selectable active tenants, and requires no X-Tenant-Id. It is NOT tenant admin
 * enumeration.
 *
 * GET /me/context is tenant-scoped and returns the caller's already-effective read capability per
 * management endpoint. `canRead` means the endpoint has at least one usable read scope (see the
 * visibility rules); the resource arrays are metadata hydrated only for scopes the caller actually
 * holds. Raw RolePermission / AccessScope / permissionKey / scopeTarget internals are never returned.
 *
 * Tenant-wide management domains expose independent `canRead` / `canManage` guidance. These booleans
 * are derived from effective permissions and never imply one another.
 *
 * `access.inventory.write` additionally reports inventory write capability (receive / adjust / transfer)
 * derived from the caller's write permissions, authorization scope, and each location's operational
 * flags. It is UX guidance ONLY: it lets a client avoid offering an action that would 403, but every
 * mutation endpoint performs the full server-side authorization independently and never trusts it.
 */

const UuidSchema = z.string().uuid();

export const MeTenantSchema = z.object({
  tenantId: UuidSchema,
  tenantName: z.string(),
  membershipId: UuidSchema,
});

export type MeTenant = z.infer<typeof MeTenantSchema>;

export const MeTenantsResponseSchema = z.array(MeTenantSchema);

export type MeTenantsResponse = z.infer<typeof MeTenantsResponseSchema>;

export const BrandRefSchema = z.object({ id: UuidSchema, name: z.string() });
export const BranchRefSchema = z.object({ id: UuidSchema, name: z.string() });
export const InventoryLocationRefSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  branchId: UuidSchema.nullable(),
});

export type BrandRef = z.infer<typeof BrandRefSchema>;
export type BranchRef = z.infer<typeof BranchRefSchema>;
export type InventoryLocationRef = z.infer<typeof InventoryLocationRefSchema>;

export const CatalogAccessSchema = z.object({
  canRead: z.boolean(),
  tenantWide: z.boolean(),
  brands: z.array(BrandRefSchema),
});

/**
 * Per-location write capability. Each boolean is server-derived by combining the caller's write
 * permission + authorization scope with the location's operational status/flags (see visibility.ts).
 * A location appears here only when at least one write permission's scope covers it. Transfer is split
 * into origin vs destination because the two are governed by independent location flags.
 */
export const InventoryWriteLocationSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  canReceive: z.boolean(),
  canAdjust: z.boolean(),
  canTransferOrigin: z.boolean(),
  canTransferDestination: z.boolean(),
});

/**
 * Inventory write-capability guidance for the Mobile client. Top-level booleans answer "is this action
 * performable at all"; `locations` carries the per-location detail needed to offer the right targets.
 * This is UX guidance ONLY — every POST route re-authorizes server-side and never trusts this shape.
 */
export const InventoryWriteAccessSchema = z.object({
  canReceive: z.boolean(),
  canAdjust: z.boolean(),
  canTransfer: z.boolean(),
  locations: z.array(InventoryWriteLocationSchema),
});

export const InventoryAccessSchema = z.object({
  canRead: z.boolean(),
  tenantWide: z.boolean(),
  locations: z.array(InventoryLocationRefSchema),
  write: InventoryWriteAccessSchema,
});

export type InventoryWriteLocation = z.infer<typeof InventoryWriteLocationSchema>;
export type InventoryWriteAccess = z.infer<typeof InventoryWriteAccessSchema>;

export const OrdersAccessSchema = z.object({
  canRead: z.boolean(),
  tenantWide: z.boolean(),
  brands: z.array(BrandRefSchema),
  branches: z.array(BranchRefSchema),
});

export const ManagementCapabilitySchema = z.object({
  canRead: z.boolean(),
  canManage: z.boolean(),
});

export const MeContextResponseSchema = z.object({
  tenant: z.object({
    id: UuidSchema,
    name: z.string(),
    status: z.enum(["provisioning", "active", "suspended", "archived"]),
  }),
  membership: z.object({ id: UuidSchema }),
  access: z.object({
    suppliers: ManagementCapabilitySchema.optional(),
    staff: ManagementCapabilitySchema.optional(),
    promotions: ManagementCapabilitySchema.optional(),
    catalog: CatalogAccessSchema,
    inventory: InventoryAccessSchema,
    orders: OrdersAccessSchema,
  }),
});

export type MeContextResponse = z.infer<typeof MeContextResponseSchema>;
