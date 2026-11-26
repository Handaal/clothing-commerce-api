import { z } from "zod";

import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import {
  CATALOG_MEDIA_BUCKET,
  nullMediaUploadSigner,
  type MediaUploadSigner,
} from "../catalog/catalog-management-service";
import { shapePublicProduct } from "../catalog/public-product-shape";
import { shapeCollectionSummary } from "../catalog/storefront-collection-service";
import {
  CreateSaleRequestSchema,
  SaleStatusSchema,
  UpdateSaleRequestSchema,
  type CreateSaleRequest,
  type UpdateSaleRequest,
} from "../contracts/management/sales";
import {
  CreateStorefrontHeroImageIntentRequestSchema,
  UpdateStorefrontContentRequestSchema,
  type CreateStorefrontHeroImageIntentRequest,
  type StorefrontHeroImageIntent,
  type UpdateStorefrontContentRequest,
} from "../contracts/management/storefront-content";
import {
  PublicStorefrontHeroSchema,
  type PublicStorefrontContent,
} from "../contracts/storefront/content";
import {
  PublicStorefrontSiteTextSchema,
  UpdateStorefrontSiteTextRequestSchema,
  type PublicStorefrontSiteText,
  type StorefrontSiteText,
} from "../contracts/storefront/site-text";
import {
  CreateCatalogImageIntentRequestSchema,
  type CatalogImageIntent,
} from "../contracts/management/catalog-images";
import { MerchandisingError } from "./errors";
import type { MerchandisingRepository } from "./repository";

/**
 * Storefront merchandising application service.
 *
 * - Sales are pricing, so they reuse the promotions vocabulary: promotions.read to view and
 *   promotions.manage to create/edit/activate/delete.
 * - Storefront content is curated catalog merchandising, so — like collections — it is authorized by
 *   catalog.author tenant-wide (read and write).
 *
 * Business rules (scope validation, tenant ownership of every referenced id, safe links, image path
 * scoping, best-price selection) are enforced by the database functions; this layer authorizes,
 * validates transport shape, and translates.
 */
export const MerchandisingPermission = {
  salesRead: "promotions.read",
  salesManage: "promotions.manage",
  content: "catalog.author",
} as const;

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: "INVALID_SALE" | "INVALID_STOREFRONT_CONTENT",
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new MerchandisingError(code, result.error.issues[0]?.message);
  }
  return result.data;
}

const DbPublicContentSchema = z.object({
  hero: z.unknown().nullable(),
  featuredHeading: z.string().nullable(),
  featuredProducts: z.array(z.unknown()),
  featuredCollections: z.array(z.unknown()),
});

export class MerchandisingService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: MerchandisingRepository,
    private readonly mediaSigner: MediaUploadSigner = nullMediaUploadSigner,
    private readonly generateId: () => string = () => crypto.randomUUID(),
  ) {}

  private authorize(context: AuthorizationContext, permissionKey: string) {
    return this.authorization.authorize(context, { permissionKey });
  }

  // ---- Sales ----
  async listSales(context: AuthorizationContext) {
    const proof = await this.authorize(context, MerchandisingPermission.salesRead);
    return this.repository.listSales(proof);
  }
  async getSale(context: AuthorizationContext, id: string) {
    const proof = await this.authorize(context, MerchandisingPermission.salesRead);
    return this.repository.getSale(proof, parse(z.uuid(), id, "INVALID_SALE"));
  }
  async createSale(context: AuthorizationContext, key: string, input: CreateSaleRequest) {
    const proof = await this.authorize(context, MerchandisingPermission.salesManage);
    return this.repository.createSale(
      proof,
      key,
      parse(CreateSaleRequestSchema, input, "INVALID_SALE"),
    );
  }
  async updateSale(context: AuthorizationContext, id: string, input: UpdateSaleRequest) {
    const proof = await this.authorize(context, MerchandisingPermission.salesManage);
    return this.repository.updateSale(
      proof,
      parse(z.uuid(), id, "INVALID_SALE"),
      parse(UpdateSaleRequestSchema, input, "INVALID_SALE"),
    );
  }
  async setSaleStatus(context: AuthorizationContext, id: string, status: unknown) {
    const proof = await this.authorize(context, MerchandisingPermission.salesManage);
    return this.repository.setSaleStatus(
      proof,
      parse(z.uuid(), id, "INVALID_SALE"),
      parse(SaleStatusSchema, status, "INVALID_SALE"),
    );
  }
  async deleteSale(context: AuthorizationContext, id: string) {
    const proof = await this.authorize(context, MerchandisingPermission.salesManage);
    return this.repository.deleteSale(proof, parse(z.uuid(), id, "INVALID_SALE"));
  }

  // ---- Storefront content ----
  async getStorefrontContent(context: AuthorizationContext) {
    const proof = await this.authorize(context, MerchandisingPermission.content);
    return this.repository.getStorefrontContent(proof);
  }

  async updateStorefrontContent(
    context: AuthorizationContext,
    input: UpdateStorefrontContentRequest,
  ) {
    const proof = await this.authorize(context, MerchandisingPermission.content);
    const body = parse(UpdateStorefrontContentRequestSchema, input, "INVALID_STOREFRONT_CONTENT");
    const image = body.hero.image;
    // The image must be one this tenant obtained from the hero-image intent (DB re-checks the prefix).
    if (
      image &&
      (image.bucket !== CATALOG_MEDIA_BUCKET ||
        !image.path.startsWith(`${context.tenant.id}/storefront/`) ||
        image.path.includes(".."))
    ) {
      throw new MerchandisingError(
        "INVALID_STOREFRONT_CONTENT",
        "The hero image must be uploaded through the storefront hero-image intent.",
      );
    }
    return this.repository.updateStorefrontContent(proof, body);
  }

  async createHeroImageIntent(
    context: AuthorizationContext,
    input: CreateStorefrontHeroImageIntentRequest,
  ): Promise<StorefrontHeroImageIntent> {
    await this.authorize(context, MerchandisingPermission.content);
    const body = parse(
      CreateStorefrontHeroImageIntentRequestSchema,
      input,
      "INVALID_STOREFRONT_CONTENT",
    );
    // Server-chosen, tenant-scoped destination; the client cannot pick the path.
    const path = `${context.tenant.id}/storefront/${this.generateId()}.${EXTENSION[body.contentType] ?? "bin"}`;
    const signed = await this.mediaSigner.sign(CATALOG_MEDIA_BUCKET, path, body.contentType);
    return {
      bucket: CATALOG_MEDIA_BUCKET,
      path,
      contentType: body.contentType,
      uploadUrl: signed?.url ?? null,
      expiresAt: signed?.expiresAt ?? null,
    };
  }

  /** Site text (SDK 0.52): all website copy outside the catalog and hero. catalog.author, like content. */
  async getStorefrontSiteText(context: AuthorizationContext): Promise<StorefrontSiteText> {
    const proof = await this.authorize(context, MerchandisingPermission.content);
    return this.repository.getStorefrontSiteText(proof);
  }

  async updateStorefrontSiteText(
    context: AuthorizationContext,
    input: unknown,
  ): Promise<StorefrontSiteText> {
    const proof = await this.authorize(context, MerchandisingPermission.content);
    const body = parse(UpdateStorefrontSiteTextRequestSchema, input, "INVALID_STOREFRONT_CONTENT");
    // Store only meaningful values: null/absent both mean "built-in text", so drop nulls.
    const document = Object.fromEntries(
      Object.entries(body.siteText).filter(([, value]) => value !== null && value !== undefined),
    );
    return this.repository.updateStorefrontSiteText(proof, document);
  }

  /** PUBLIC: no session; unknown or inactive tenants read an empty document (built-in text). */
  async getPublicStorefrontSiteText(tenantId: string): Promise<PublicStorefrontSiteText> {
    const raw = await this.repository.getPublicStorefrontSiteText(tenantId);
    const parsed = PublicStorefrontSiteTextSchema.safeParse(raw);
    // A document written before a contract tightening must never break the website: fall back.
    return parsed.success ? parsed.data : { siteText: {} };
  }

  /** SDK 0.53: destination for a collection cover / category image ("<tenant>/catalog/<id>.<ext>"). */
  async createCatalogImageIntent(
    context: AuthorizationContext,
    input: unknown,
  ): Promise<CatalogImageIntent> {
    await this.authorize(context, MerchandisingPermission.content);
    const body = parse(CreateCatalogImageIntentRequestSchema, input, "INVALID_STOREFRONT_CONTENT");
    const path = `${context.tenant.id}/catalog/${this.generateId()}.${EXTENSION[body.contentType] ?? "bin"}`;
    const signed = await this.mediaSigner.sign(CATALOG_MEDIA_BUCKET, path, body.contentType);
    return {
      bucket: CATALOG_MEDIA_BUCKET,
      path,
      contentType: body.contentType,
      uploadUrl: signed?.url ?? null,
      expiresAt: signed?.expiresAt ?? null,
    };
  }

  /** PUBLIC: no session; the tenant is explicit and the DB projection is published-only. */
  async getPublicStorefrontContent(
    tenantId: string,
    brandId: string | null,
  ): Promise<PublicStorefrontContent> {
    const raw = DbPublicContentSchema.parse(
      await this.repository.getPublicStorefrontContent(tenantId, brandId),
    );
    return {
      hero: raw.hero === null ? null : PublicStorefrontHeroSchema.parse(raw.hero),
      featuredHeading: raw.featuredHeading,
      featuredProducts: raw.featuredProducts.map(shapePublicProduct),
      featuredCollections: raw.featuredCollections.map(shapeCollectionSummary),
    };
  }
}
