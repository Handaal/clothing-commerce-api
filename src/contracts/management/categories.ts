import { z } from "zod";

import { CatalogImageSchema } from "./catalog-images";

import { SizeGuideSchema } from "../storefront/catalog";

/**
 * Category management DTOs. Categories are a tenant-owned single-parent taxonomy (e.g. Men → T-Shirts)
 * used for Storefront navigation and filtering. Top-level categories typically represent the audience
 * (e.g. Men); children are product types. Cycles are rejected by the database. Lifecycle is
 * active ↔ archived; an archived category (or any descendant of one) disappears from the Storefront.
 */

const UuidSchema = z.string().uuid();
const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u, "Slug must be kebab-case alphanumeric.");
const NameSchema = z.string().trim().min(1).max(200);
const DescriptionSchema = z.string().trim().min(1).max(2000);

export const CategoryStatusSchema = z.enum(["active", "archived"]);
export type CategoryStatus = z.infer<typeof CategoryStatusSchema>;

export const CategorySummarySchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  position: z.number().int().nonnegative(),
  status: CategoryStatusSchema,
  // Products directly assigned to this category (any product status).
  productCount: z.number().int().nonnegative(),
  // SDK 0.46: the size chart products in this category (or its descendants) show; null when none.
  sizeGuide: SizeGuideSchema.nullable().optional(),
  // SDK 0.53: the category's own image for website tiles (null = a product photo is used).
  image: CatalogImageSchema.nullable().optional(),
});
export type CategorySummary = z.infer<typeof CategorySummarySchema>;

export const CategoryListResponseSchema = z.object({
  categories: z.array(CategorySummarySchema),
});
export type CategoryListResponse = z.infer<typeof CategoryListResponseSchema>;

export const CreateCategoryRequestSchema = z
  .object({
    parentId: UuidSchema.nullable().optional(),
    name: NameSchema,
    slug: SlugSchema,
    description: DescriptionSchema.optional(),
    // Display order among siblings; appended last when omitted.
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

export const UpdateCategoryRequestSchema = z
  .object({
    parentId: UuidSchema.nullable(),
    name: NameSchema,
    slug: SlugSchema,
    description: DescriptionSchema.optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequestSchema>;

export const SetCategoryStatusRequestSchema = z
  .object({
    status: CategoryStatusSchema,
    archiveReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type SetCategoryStatusRequest = z.infer<typeof SetCategoryStatusRequestSchema>;

export const CategoryWriteResponseSchema = z.object({
  categoryId: UuidSchema,
  status: CategoryStatusSchema,
});
export type CategoryWriteResponse = z.infer<typeof CategoryWriteResponseSchema>;

export const CategoryUpdatedResponseSchema = z.object({ categoryId: UuidSchema });
export type CategoryUpdatedResponse = z.infer<typeof CategoryUpdatedResponseSchema>;

export const SetCategorySizeGuideRequestSchema = z
  .object({
    // The complete size chart; null removes it.
    sizeGuide: SizeGuideSchema.nullable(),
  })
  .strict();
export type SetCategorySizeGuideRequest = z.infer<typeof SetCategorySizeGuideRequestSchema>;

export const SetCategorySizeGuideResponseSchema = z.object({
  categoryId: UuidSchema,
  hasSizeGuide: z.boolean(),
});
export type SetCategorySizeGuideResponse = z.infer<typeof SetCategorySizeGuideResponseSchema>;

export const SetProductCategoriesRequestSchema = z
  .object({
    // The product's complete category membership; an empty array removes it from all categories.
    categoryIds: z.array(UuidSchema).max(50),
  })
  .strict();
export type SetProductCategoriesRequest = z.infer<typeof SetProductCategoriesRequestSchema>;

export const SetProductCategoriesResponseSchema = z.object({
  productId: UuidSchema,
  categoryCount: z.number().int().nonnegative(),
});
export type SetProductCategoriesResponse = z.infer<typeof SetProductCategoriesResponseSchema>;
