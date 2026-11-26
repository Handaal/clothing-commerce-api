import { z } from "zod";

/**
 * Storefront home-page content (management). One document per tenant: the hero (eyebrow, title,
 * subtitle, call-to-action, image) and the curated featured product / collection lists, in display
 * order. This is structured content, not a page-layout editor: the Storefront owns the layout.
 * The hero image lives in the catalog media bucket under "<tenantId>/storefront/" — obtain a destination
 * with the hero-image upload intent, PUT the bytes to its signed URL, then save the bucket/path here.
 * Authorized by catalog.author (tenant-wide), like collections.
 */

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const StorefrontHeroImageSchema = z.object({
  bucket: z.string(),
  path: z.string(),
  altText: z.string().nullable(),
});

export const StorefrontHeroSchema = z.object({
  eyebrow: z.string().nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  ctaLabel: z.string().nullable(),
  ctaHref: z.string().nullable(),
  image: StorefrontHeroImageSchema.nullable(),
});

export const StorefrontContentSchema = z.object({
  hero: StorefrontHeroSchema,
  featuredHeading: z.string().nullable(),
  featuredProductIds: z.array(z.uuid()),
  featuredCollectionIds: z.array(z.uuid()),
  // null until the content has been saved once.
  updatedAt: z.string().nullable(),
});

// Internal links ("/catalog", "/collections/summer") or absolute https URLs only.
const CtaHrefSchema = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || v === "/" || /^\/[^/]/.test(v) || /^https:\/\//.test(v), {
    message: "Use an internal path such as /catalog, or an https:// link.",
  });

export const UpdateStorefrontContentRequestSchema = z
  .object({
    hero: z
      .object({
        eyebrow: optionalText(80),
        title: optionalText(160),
        subtitle: optionalText(400),
        ctaLabel: optionalText(40),
        ctaHref: CtaHrefSchema.nullable().optional(),
        image: z
          .object({
            bucket: z.string().min(1).max(100),
            path: z.string().min(1).max(500),
            altText: z.string().trim().max(300).nullable().optional(),
          })
          .strict()
          .nullable()
          .optional(),
      })
      .strict(),
    featuredHeading: optionalText(120),
    featuredProductIds: z.array(z.uuid()).max(24),
    featuredCollectionIds: z.array(z.uuid()).max(12),
  })
  .strict();

export const CreateStorefrontHeroImageIntentRequestSchema = z
  .object({
    contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
    fileName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const StorefrontHeroImageIntentSchema = z.object({
  bucket: z.string(),
  path: z.string(),
  contentType: z.string(),
  uploadUrl: z.string().url().nullable(),
  expiresAt: z.string().nullable(),
});

export type StorefrontHeroImage = z.infer<typeof StorefrontHeroImageSchema>;
export type StorefrontHero = z.infer<typeof StorefrontHeroSchema>;
export type StorefrontContent = z.infer<typeof StorefrontContentSchema>;
export type UpdateStorefrontContentRequest = z.infer<typeof UpdateStorefrontContentRequestSchema>;
export type CreateStorefrontHeroImageIntentRequest = z.infer<
  typeof CreateStorefrontHeroImageIntentRequestSchema
>;
export type StorefrontHeroImageIntent = z.infer<typeof StorefrontHeroImageIntentSchema>;
