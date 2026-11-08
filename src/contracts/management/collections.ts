import { z } from "zod";

/**
 * Collections management DTOs. A collection is a tenant-owned, manually curated grouping of products.
 * These are task-oriented projections, never raw rows. Slugs are normalized (lower/trim) by the
 * database; the schema accepts mixed case but requires kebab shape so an invalid slug is rejected
 * before the write boundary. Lifecycle mirrors catalog: draft → active (public) → archived.
 */

const UuidSchema = z.string().uuid();
const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u, "Slug must be kebab-case alphanumeric.");
const NameSchema = z.string().trim().min(1).max(200);
const DescriptionSchema = z.string().trim().min(1).max(5000);

export const CollectionStatusSchema = z.enum(["draft", "active", "archived"]);
export type CollectionStatus = z.infer<typeof CollectionStatusSchema>;

export const CollectionSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: CollectionStatusSchema,
  productCount: z.number().int().nonnegative(),
});
export type CollectionSummary = z.infer<typeof CollectionSummarySchema>;

export const CollectionListResponseSchema = z.object({
  collections: z.array(CollectionSummarySchema),
});
export type CollectionListResponse = z.infer<typeof CollectionListResponseSchema>;

export const CollectionDetailResponseSchema = z.object({
  collection: CollectionSummarySchema,
  productIds: z.array(UuidSchema),
});
export type CollectionDetailResponse = z.infer<typeof CollectionDetailResponseSchema>;

export const CreateCollectionRequestSchema = z
  .object({
    name: NameSchema,
    slug: SlugSchema,
    description: DescriptionSchema.optional(),
  })
  .strict();
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequestSchema>;

export const UpdateCollectionRequestSchema = z
  .object({
    name: NameSchema,
    slug: SlugSchema,
    description: DescriptionSchema.optional(),
  })
  .strict();
export type UpdateCollectionRequest = z.infer<typeof UpdateCollectionRequestSchema>;

export const SetCollectionStatusRequestSchema = z
  .object({
    status: CollectionStatusSchema,
    archiveReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type SetCollectionStatusRequest = z.infer<typeof SetCollectionStatusRequestSchema>;

export const SetCollectionProductsRequestSchema = z
  .object({
    // The authoritative, position-ordered product list. An empty array clears the collection.
    productIds: z.array(UuidSchema).max(500),
  })
  .strict();
export type SetCollectionProductsRequest = z.infer<typeof SetCollectionProductsRequestSchema>;

export const CollectionWriteResponseSchema = z.object({
  collectionId: UuidSchema,
  status: CollectionStatusSchema,
});
export type CollectionWriteResponse = z.infer<typeof CollectionWriteResponseSchema>;

export const CollectionUpdatedResponseSchema = z.object({
  collectionId: UuidSchema,
});
export type CollectionUpdatedResponse = z.infer<typeof CollectionUpdatedResponseSchema>;

export const SetCollectionProductsResponseSchema = z.object({
  collectionId: UuidSchema,
  productCount: z.number().int().nonnegative(),
});
export type SetCollectionProductsResponse = z.infer<typeof SetCollectionProductsResponseSchema>;
