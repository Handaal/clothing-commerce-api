import { z } from "zod";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
} from "../common/serialization";
import { ProductStatusSchema } from "./products";

/**
 * Phase 2J catalog management WRITE contracts. Each request carries only business fields; the
 * idempotency key is supplied out-of-band via the required Idempotency-Key header, and the tenant,
 * actor membership, and authorization context are derived server-side. `.strict()` rejects unknown
 * keys. Responses mirror the sanctioned function results; no internal lifecycle or storage internals
 * beyond the returned identifiers are exposed.
 */

const UuidSchema = z.string().uuid();

// A slug is normalized (lower/trim) by the database; accept mixed case but require kebab shape so an
// invalid slug is rejected before the write boundary.
const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u, "Slug must be kebab-case alphanumeric.");
const NameSchema = z.string().trim().min(1).max(200);
const StyleCodeSchema = z.string().trim().min(1).max(100);
const DescriptionSchema = z.string().trim().min(1).max(5000);
const SkuSchema = z.string().trim().min(1).max(100);
const AltTextSchema = z.string().trim().min(1).max(300);
const StorageComponentSchema = z.string().trim().min(1).max(200);

export const StorefrontStatusSchema = z.enum(["unpublished", "published"]);
export type StorefrontStatus = z.infer<typeof StorefrontStatusSchema>;

// ---- Product ----
export const CreateProductRequestSchema = z
  .object({
    brandId: UuidSchema,
    name: NameSchema,
    slug: SlugSchema,
    styleCode: StyleCodeSchema.optional(),
    description: DescriptionSchema.optional(),
  })
  .strict();
export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

export const UpdateProductRequestSchema = z
  .object({
    name: NameSchema,
    slug: SlugSchema,
    styleCode: StyleCodeSchema.optional(),
    description: DescriptionSchema.optional(),
  })
  .strict();
export type UpdateProductRequest = z.infer<typeof UpdateProductRequestSchema>;

export const SetProductStatusRequestSchema = z
  .object({
    status: ProductStatusSchema,
    archiveReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type SetProductStatusRequest = z.infer<typeof SetProductStatusRequestSchema>;

export const ProductWriteResponseSchema = z.object({
  productId: UuidSchema,
  status: ProductStatusSchema,
  storefrontStatus: StorefrontStatusSchema,
});
export type ProductWriteResponse = z.infer<typeof ProductWriteResponseSchema>;

export const ProductUpdatedResponseSchema = z.object({ productId: UuidSchema });
export type ProductUpdatedResponse = z.infer<typeof ProductUpdatedResponseSchema>;

// ---- Publication (distinct catalog.publish permission) ----
export const PublishProductRequestSchema = z.object({}).strict();
export type PublishProductRequest = z.infer<typeof PublishProductRequestSchema>;

export const PublishProductResponseSchema = z.object({
  productId: UuidSchema,
  storefrontStatus: StorefrontStatusSchema,
  publishedAt: IsoDateTimeSchema.nullable(),
});
export type PublishProductResponse = z.infer<typeof PublishProductResponseSchema>;

export const UnpublishProductResponseSchema = z.object({
  productId: UuidSchema,
  storefrontStatus: StorefrontStatusSchema,
});
export type UnpublishProductResponse = z.infer<typeof UnpublishProductResponseSchema>;

// ---- Variant ----
export const CreateVariantRequestSchema = z
  .object({
    sku: SkuSchema,
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CreateVariantRequest = z.infer<typeof CreateVariantRequestSchema>;

export const CreateVariantResponseSchema = z.object({
  variantId: UuidSchema,
  status: ProductStatusSchema,
});
export type CreateVariantResponse = z.infer<typeof CreateVariantResponseSchema>;

// ---- Pricing ----
export const SetVariantPriceRequestSchema = z
  .object({
    currency: CurrencySchema,
    amountMinor: NonNegativeIntegerSchema,
  })
  .strict();
export type SetVariantPriceRequest = z.infer<typeof SetVariantPriceRequestSchema>;

export const SetVariantPriceResponseSchema = z.object({
  priceId: UuidSchema,
  currency: CurrencySchema,
  amountMinor: NonNegativeIntegerSchema,
});
export type SetVariantPriceResponse = z.infer<typeof SetVariantPriceResponseSchema>;

// ---- Media ----
// The server owns the storage destination. The client declares intent (content type, optional
// variant/file name); the server returns a tenant/product-scoped path and, when object storage is
// reachable, a constrained signed upload URL. The client uploads the object then registers the
// reference via addProductMedia. The client can never choose an arbitrary storage destination.
const ImageContentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export const CreateMediaUploadIntentRequestSchema = z
  .object({
    variantId: UuidSchema.optional(),
    contentType: ImageContentTypeSchema,
    fileName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CreateMediaUploadIntentRequest = z.infer<typeof CreateMediaUploadIntentRequestSchema>;

export const MediaUploadIntentResponseSchema = z.object({
  bucket: z.string(),
  path: z.string(),
  contentType: ImageContentTypeSchema,
  // Present only when object storage is reachable; otherwise the client uploads via the documented
  // storage integration using the server-authorized bucket/path.
  uploadUrl: z.string().url().nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type MediaUploadIntentResponse = z.infer<typeof MediaUploadIntentResponseSchema>;

export const RegisterProductMediaRequestSchema = z
  .object({
    variantId: UuidSchema.optional(),
    bucket: StorageComponentSchema,
    path: StorageComponentSchema,
    altText: AltTextSchema.optional(),
    position: NonNegativeIntegerSchema.optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();
export type RegisterProductMediaRequest = z.infer<typeof RegisterProductMediaRequestSchema>;

export const RegisterProductMediaResponseSchema = z.object({
  mediaId: UuidSchema,
  isPrimary: z.boolean(),
});
export type RegisterProductMediaResponse = z.infer<typeof RegisterProductMediaResponseSchema>;

export const ArchiveProductMediaResponseSchema = z.object({ mediaId: UuidSchema });
export type ArchiveProductMediaResponse = z.infer<typeof ArchiveProductMediaResponseSchema>;
