import { z } from "zod";

import { PublicProductSchema } from "./catalog";
import { PublicCollectionSummarySchema } from "./collections";

/**
 * PUBLIC Storefront home-page content. The hero copy/image and the curated featured products and
 * collections, resolved to the same Storefront-safe projections as the catalog and collection reads.
 * Only publicly visible products/collections are ever returned (unpublished picks are skipped), in the
 * curated order. `hero` is null when the tenant has never saved content — the Storefront then falls
 * back to its own defaults.
 */
export const PublicStorefrontHeroSchema = z.object({
  eyebrow: z.string().nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  ctaLabel: z.string().nullable(),
  ctaHref: z.string().nullable(),
  image: z
    .object({ bucket: z.string(), path: z.string(), altText: z.string().nullable() })
    .nullable(),
});
export type PublicStorefrontHero = z.infer<typeof PublicStorefrontHeroSchema>;

export const PublicStorefrontContentSchema = z.object({
  hero: PublicStorefrontHeroSchema.nullable(),
  featuredHeading: z.string().nullable(),
  featuredProducts: z.array(PublicProductSchema),
  featuredCollections: z.array(PublicCollectionSummarySchema),
});
export type PublicStorefrontContent = z.infer<typeof PublicStorefrontContentSchema>;
