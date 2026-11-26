import { z } from "zod";

/**
 * Website images and photo editing (SDK 0.53).
 *
 * - Collections can carry a custom COVER image and categories an IMAGE (category tiles). Both live in
 *   the catalog media bucket under "<tenantId>/catalog/": get a destination from the catalog-image
 *   upload intent, PUT the bytes to its signed URL, then save { bucket, path, altText } on the
 *   collection/category. `image: null` removes it and the website falls back to a product photo.
 * - Product photos can be listed, described (alt text), made the main photo, and reordered (the first
 *   photo of an order becomes the main one).
 * Authorized by catalog.author (tenant-wide for collections/categories; the product's brand for photos).
 */

const Uuid = z.uuid();

export const CatalogImageSchema = z.object({
  bucket: z.string(),
  path: z.string(),
  altText: z.string().nullable(),
});

export const CatalogImageInputSchema = z
  .object({
    bucket: z.string().min(1).max(100),
    path: z.string().min(1).max(500),
    altText: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export const CreateCatalogImageIntentRequestSchema = z
  .object({
    contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
    fileName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const CatalogImageIntentSchema = z.object({
  bucket: z.string(),
  path: z.string(),
  contentType: z.string(),
  uploadUrl: z.string().url().nullable(),
  expiresAt: z.string().nullable(),
});

export const SetCatalogImageRequestSchema = z
  .object({ image: CatalogImageInputSchema.nullable() })
  .strict();

export const SetCollectionImageResponseSchema = z.object({
  collectionId: Uuid,
  hasImage: z.boolean(),
});
export const SetCategoryImageResponseSchema = z.object({
  categoryId: Uuid,
  hasImage: z.boolean(),
});

// ---- Product photos ----
export const ProductMediaItemSchema = z.object({
  id: Uuid,
  variantId: Uuid.nullable(),
  bucket: z.string(),
  path: z.string(),
  altText: z.string().nullable(),
  position: z.number().int().nonnegative(),
  isPrimary: z.boolean(),
});
/** Active photos in display order (main photo first). */
export const ProductMediaListResponseSchema = z.object({ media: z.array(ProductMediaItemSchema) });

export const UpdateProductMediaRequestSchema = z
  .object({
    // null or "" clears the description.
    altText: z.string().trim().max(300).nullable().optional(),
    // Only `true` is meaningful: choosing another photo as main un-sets the previous one.
    isPrimary: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => v.altText !== undefined || v.isPrimary !== undefined, {
    message: "Change the description or choose it as the main photo.",
  });
export const UpdateProductMediaResponseSchema = z.object({
  mediaId: Uuid,
  isPrimary: z.boolean(),
  altText: z.string().nullable(),
});

export const ReorderProductMediaRequestSchema = z
  .object({ mediaIds: z.array(Uuid).min(1).max(100) })
  .strict();
export const ReorderProductMediaResponseSchema = z.object({
  productId: Uuid,
  mediaCount: z.number().int().nonnegative(),
});

export type CatalogImage = z.infer<typeof CatalogImageSchema>;
export type CatalogImageInput = z.infer<typeof CatalogImageInputSchema>;
export type CreateCatalogImageIntentRequest = z.infer<typeof CreateCatalogImageIntentRequestSchema>;
export type CatalogImageIntent = z.infer<typeof CatalogImageIntentSchema>;
export type SetCatalogImageRequest = z.infer<typeof SetCatalogImageRequestSchema>;
export type SetCollectionImageResponse = z.infer<typeof SetCollectionImageResponseSchema>;
export type SetCategoryImageResponse = z.infer<typeof SetCategoryImageResponseSchema>;
export type ProductMediaItem = z.infer<typeof ProductMediaItemSchema>;
export type ProductMediaListResponse = z.infer<typeof ProductMediaListResponseSchema>;
export type UpdateProductMediaRequest = z.infer<typeof UpdateProductMediaRequestSchema>;
export type UpdateProductMediaResponse = z.infer<typeof UpdateProductMediaResponseSchema>;
export type ReorderProductMediaRequest = z.infer<typeof ReorderProductMediaRequestSchema>;
export type ReorderProductMediaResponse = z.infer<typeof ReorderProductMediaResponseSchema>;
