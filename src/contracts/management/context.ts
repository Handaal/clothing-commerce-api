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

export const InventoryAccessSchema = z.object({
  canRead: z.boolean(),
  tenantWide: z.boolean(),
  locations: z.array(InventoryLocationRefSchema),
});

export const OrdersAccessSchema = z.object({
  canRead: z.boolean(),
  tenantWide: z.boolean(),
  brands: z.array(BrandRefSchema),
  branches: z.array(BranchRefSchema),
});

export const MeContextResponseSchema = z.object({
  tenant: z.object({
    id: UuidSchema,
    name: z.string(),
    status: z.enum(["provisioning", "active", "suspended", "archived"]),
  }),
  membership: z.object({ id: UuidSchema }),
  access: z.object({
    catalog: CatalogAccessSchema,
    inventory: InventoryAccessSchema,
    orders: OrdersAccessSchema,
  }),
});

export type MeContextResponse = z.infer<typeof MeContextResponseSchema>;
