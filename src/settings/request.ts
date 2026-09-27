import { z } from "zod";
import { LifecycleStatusSchema } from "../contracts/management/settings";

/** Shared keyset pagination query for the settings list surfaces. */
export const SettingsPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const BrandListQuerySchema = SettingsPageQuerySchema.extend({
  status: LifecycleStatusSchema.optional(),
});
export const BranchListQuerySchema = BrandListQuerySchema;
export const WarehouseListQuerySchema = BrandListQuerySchema;
export const RegisterListQuerySchema = SettingsPageQuerySchema.extend({
  status: LifecycleStatusSchema.optional(),
  branchId: z.uuid().optional(),
});
export const InventoryLocationListQuerySchema = SettingsPageQuerySchema.extend({
  status: LifecycleStatusSchema.optional(),
  branchId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
});
export const DeviceListQuerySchema = SettingsPageQuerySchema.extend({
  status: z.enum(["enrolled", "active", "revoked"]).optional(),
});

export const BrandPathSchema = z.object({ brandId: z.uuid() });
export const BranchPathSchema = z.object({ branchId: z.uuid() });
export const WarehousePathSchema = z.object({ warehouseId: z.uuid() });
export const InventoryLocationPathSchema = z.object({ locationId: z.uuid() });
export const RegisterPathSchema = z.object({ registerId: z.uuid() });
export const DevicePathSchema = z.object({ deviceId: z.uuid() });
export const StorefrontPathSchema = z.object({ brandId: z.uuid() });

export type SettingsPageQuery = z.infer<typeof SettingsPageQuerySchema>;
export type BrandListQuery = z.infer<typeof BrandListQuerySchema>;
export type BranchListQuery = z.infer<typeof BranchListQuerySchema>;
export type WarehouseListQuery = z.infer<typeof WarehouseListQuerySchema>;
export type RegisterListQuery = z.infer<typeof RegisterListQuerySchema>;
export type InventoryLocationListQuery = z.infer<typeof InventoryLocationListQuerySchema>;
export type DeviceListQuery = z.infer<typeof DeviceListQuerySchema>;
