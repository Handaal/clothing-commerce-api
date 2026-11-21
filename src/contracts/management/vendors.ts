import { z } from "zod";

/**
 * Vendor management DTOs (SDK 0.50). A vendor is the label a product is made by (e.g. Zara, Polo,
 * H&M, Armani Exchange or a local label). The apps call it "Brand"; it is not the tenant's own
 * `brands` (the selling brand, e.g. Zee Store). Vendors are tenant-wide; a product has at most one.
 * Lifecycle is active ↔ archived; an archived vendor disappears from the Storefront.
 */

const UuidSchema = z.string().uuid();
const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u, "Slug must be kebab-case alphanumeric.");
const NameSchema = z.string().trim().min(1).max(120);

export const VendorStatusSchema = z.enum(["active", "archived"]);
export type VendorStatus = z.infer<typeof VendorStatusSchema>;

export const VendorSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  position: z.number().int().nonnegative(),
  status: VendorStatusSchema,
  // Products assigned to this vendor (any product status).
  productCount: z.number().int().nonnegative(),
});
export type VendorSummary = z.infer<typeof VendorSummarySchema>;

export const VendorListResponseSchema = z.object({ vendors: z.array(VendorSummarySchema) });
export type VendorListResponse = z.infer<typeof VendorListResponseSchema>;

export const CreateVendorRequestSchema = z
  .object({
    name: NameSchema,
    slug: SlugSchema,
    // Display order; appended last when omitted.
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type CreateVendorRequest = z.infer<typeof CreateVendorRequestSchema>;

export const UpdateVendorRequestSchema = CreateVendorRequestSchema;
export type UpdateVendorRequest = z.infer<typeof UpdateVendorRequestSchema>;

export const SetVendorStatusRequestSchema = z.object({ status: VendorStatusSchema }).strict();
export type SetVendorStatusRequest = z.infer<typeof SetVendorStatusRequestSchema>;

export const VendorWriteResponseSchema = z.object({
  vendorId: UuidSchema,
  status: VendorStatusSchema,
});
export type VendorWriteResponse = z.infer<typeof VendorWriteResponseSchema>;

export const VendorUpdatedResponseSchema = z.object({ vendorId: UuidSchema });
export type VendorUpdatedResponse = z.infer<typeof VendorUpdatedResponseSchema>;

export const SetProductVendorRequestSchema = z
  .object({
    // The product's vendor; null clears it.
    vendorId: UuidSchema.nullable(),
  })
  .strict();
export type SetProductVendorRequest = z.infer<typeof SetProductVendorRequestSchema>;

export const SetProductVendorResponseSchema = z.object({
  productId: UuidSchema,
  vendorId: UuidSchema.nullable(),
});
export type SetProductVendorResponse = z.infer<typeof SetProductVendorResponseSchema>;
