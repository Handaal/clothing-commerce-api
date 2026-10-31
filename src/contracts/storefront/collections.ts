import { z } from "zod";

import { NonNegativeIntegerSchema } from "../common/serialization";
import { PublicProductSchema } from "./catalog";

/**
 * PUBLIC Storefront collection read contracts. A collection is a tenant-owned, manually curated group
 * of products. Only 'active' collections that own at least one publicly visible product are ever
 * exposed, and the products inside carry the same Storefront-safe projection as the catalog read: no
 * internal lifecycle, cost, or exact stock. The list view carries a lightweight cover + product count;
 * the detail view carries the full ordered product array.
 */

const UuidSchema = z.string().uuid();

export const PublicCollectionCoverSchema = z.object({
  bucket: z.string(),
  path: z.string(),
  altText: z.string().nullable(),
});
export type PublicCollectionCover = z.infer<typeof PublicCollectionCoverSchema>;

export const PublicCollectionSummarySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  productCount: NonNegativeIntegerSchema,
  cover: PublicCollectionCoverSchema.nullable(),
});
export type PublicCollectionSummary = z.infer<typeof PublicCollectionSummarySchema>;

export const PublicCollectionListResponseSchema = z.object({
  collections: z.array(PublicCollectionSummarySchema),
});
export type PublicCollectionListResponse = z.infer<typeof PublicCollectionListResponseSchema>;

export const PublicCollectionDetailSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  products: z.array(PublicProductSchema),
});
export type PublicCollectionDetail = z.infer<typeof PublicCollectionDetailSchema>;

export const PublicCollectionDetailResponseSchema = PublicCollectionDetailSchema;
export type PublicCollectionDetailResponse = z.infer<typeof PublicCollectionDetailResponseSchema>;
