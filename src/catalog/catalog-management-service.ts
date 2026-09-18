import {
  executeAuthorizedOperation,
  type AuthorizationContext,
  type AuthorizationResource,
  type AuthorizationService,
} from "../authorization";
import { CatalogError } from "./catalog-errors";
import type {
  CatalogWriteRepository,
  ProductWriteResult,
  PublishResult,
} from "./catalog-write-repository";

/** The Phase 2J catalog permission vocabulary. Publication is deliberately a distinct capability. */
export const CatalogPermission = {
  author: "catalog.author",
  publish: "catalog.publish",
} as const;

/** The single object-storage bucket for catalog imagery. The server owns every destination path. */
export const CATALOG_MEDIA_BUCKET = "product-media";

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

/**
 * Mints a constrained signed upload URL for an already server-authorized bucket/path. Implementations
 * must never let the caller influence the destination. A null result means object storage is not
 * reachable in this environment; the client then uploads via the documented storage integration using
 * the server-authorized bucket/path.
 */
export interface MediaUploadSigner {
  sign(
    bucket: string,
    path: string,
    contentType: string,
  ): Promise<{ url: string; expiresAt: string } | null>;
}

export const nullMediaUploadSigner: MediaUploadSigner = {
  async sign() {
    return null;
  },
};

function brandResource(id: string): AuthorizationResource {
  return { kind: "brand", id };
}

export interface CreateProductInput {
  brandId: string;
  name: string;
  slug: string;
  styleCode?: string;
  description?: string;
}
export interface UpdateProductInput {
  name: string;
  slug: string;
  styleCode?: string;
  description?: string;
}
export interface SetProductStatusInput {
  status: "draft" | "active" | "archived";
  archiveReason?: string;
}
export interface CreateVariantInput {
  sku: string;
  displayName?: string;
}
export interface SetVariantPriceInput {
  currency: string;
  amountMinor: number;
}
export interface RegisterMediaInput {
  variantId?: string;
  bucket: string;
  path: string;
  altText?: string;
  position?: number;
  isPrimary?: boolean;
}
export interface CreateMediaUploadIntentInput {
  variantId?: string;
  contentType: string;
  fileName?: string;
}
export interface MediaUploadIntent {
  bucket: string;
  path: string;
  contentType: string;
  uploadUrl: string | null;
  expiresAt: string | null;
}

/**
 * Phase 2J catalog management application service. It is the only place the API expresses catalog write
 * intent. Every command authorizes the appropriate permission (`catalog.author` for editing,
 * `catalog.publish` for publication) against the target product's brand resource via the shared
 * authorization service before any privileged database access, derives the actor membership from the
 * verified context, and delegates the write to the repository. service_role is transport, never
 * authorization.
 */
export class CatalogManagementService {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly repository: CatalogWriteRepository,
    private readonly mediaSigner: MediaUploadSigner = nullMediaUploadSigner,
    private readonly generateId: () => string = () => crypto.randomUUID(),
  ) {}

  async createProduct(
    context: AuthorizationContext,
    idempotencyKey: string,
    input: CreateProductInput,
  ): Promise<ProductWriteResult> {
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: CatalogPermission.author,
        resources: [brandResource(input.brandId)],
      },
      operation: (proof) =>
        this.repository.createProduct(proof, {
          tenantId: context.tenant.id,
          brandId: input.brandId,
          name: input.name,
          slug: input.slug,
          styleCode: input.styleCode ?? null,
          description: input.description ?? null,
          actorMembershipId: context.membership.id,
          idempotencyKey,
        }),
    });
  }

  async updateProduct(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
    input: UpdateProductInput,
  ): Promise<{ productId: string }> {
    const brandId = await this.requireProductBrand(context.tenant.id, productId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.author, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.updateProduct(proof, {
          tenantId: context.tenant.id,
          productId,
          name: input.name,
          slug: input.slug,
          styleCode: input.styleCode ?? null,
          description: input.description ?? null,
          idempotencyKey,
        }),
    });
  }

  async setProductStatus(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
    input: SetProductStatusInput,
  ): Promise<ProductWriteResult> {
    const brandId = await this.requireProductBrand(context.tenant.id, productId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.author, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.setProductStatus(proof, {
          tenantId: context.tenant.id,
          productId,
          status: input.status,
          archiveReason: input.archiveReason ?? null,
          idempotencyKey,
        }),
    });
  }

  async createVariant(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
    input: CreateVariantInput,
  ): Promise<{ variantId: string; status: "draft" | "active" | "archived" }> {
    const brandId = await this.requireProductBrand(context.tenant.id, productId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.author, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.createVariant(proof, {
          tenantId: context.tenant.id,
          productId,
          sku: input.sku,
          displayName: input.displayName ?? null,
          idempotencyKey,
        }),
    });
  }

  async setVariantPrice(
    context: AuthorizationContext,
    variantId: string,
    idempotencyKey: string,
    input: SetVariantPriceInput,
  ): Promise<{ priceId: string; currency: string; amountMinor: number }> {
    const brandId = await this.requireVariantBrand(context.tenant.id, variantId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.author, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.setVariantPrice(proof, {
          tenantId: context.tenant.id,
          variantId,
          currency: input.currency,
          amountMinor: input.amountMinor,
          idempotencyKey,
        }),
    });
  }

  async publishProduct(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
  ): Promise<PublishResult> {
    const brandId = await this.requireProductBrand(context.tenant.id, productId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.publish, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.publishProduct(proof, {
          tenantId: context.tenant.id,
          productId,
          idempotencyKey,
        }),
    });
  }

  async unpublishProduct(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
  ): Promise<{ productId: string; storefrontStatus: "unpublished" }> {
    const brandId = await this.requireProductBrand(context.tenant.id, productId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.publish, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.unpublishProduct(proof, {
          tenantId: context.tenant.id,
          productId,
          idempotencyKey,
        }),
    });
  }

  async createMediaUploadIntent(
    context: AuthorizationContext,
    productId: string,
    input: CreateMediaUploadIntentInput,
  ): Promise<MediaUploadIntent> {
    const brandId = await this.requireProductBrand(context.tenant.id, productId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.author, resources: [brandResource(brandId)] },
      operation: async () => {
        // The server constructs the destination; the client cannot choose an arbitrary path. The path
        // is scoped to the tenant and product, so a signed URL can never target another tenant.
        const extension = CONTENT_TYPE_EXTENSION[input.contentType] ?? "bin";
        const path = `${context.tenant.id}/${productId}/${this.generateId()}.${extension}`;
        const signed = await this.mediaSigner.sign(CATALOG_MEDIA_BUCKET, path, input.contentType);
        return {
          bucket: CATALOG_MEDIA_BUCKET,
          path,
          contentType: input.contentType,
          uploadUrl: signed?.url ?? null,
          expiresAt: signed?.expiresAt ?? null,
        };
      },
    });
  }

  async registerMedia(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
    input: RegisterMediaInput,
  ): Promise<{ mediaId: string; isPrimary: boolean }> {
    const brandId = await this.requireProductBrand(context.tenant.id, productId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.author, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.addProductMedia(proof, {
          tenantId: context.tenant.id,
          productId,
          variantId: input.variantId ?? null,
          bucket: input.bucket,
          path: input.path,
          altText: input.altText ?? null,
          position: input.position ?? null,
          isPrimary: input.isPrimary ?? false,
          idempotencyKey,
        }),
    });
  }

  async archiveMedia(
    context: AuthorizationContext,
    mediaId: string,
    idempotencyKey: string,
  ): Promise<{ mediaId: string }> {
    const brandId = await this.requireMediaBrand(context.tenant.id, mediaId);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: { permissionKey: CatalogPermission.author, resources: [brandResource(brandId)] },
      operation: (proof) =>
        this.repository.archiveProductMedia(proof, {
          tenantId: context.tenant.id,
          mediaId,
          idempotencyKey,
        }),
    });
  }

  private async requireProductBrand(tenantId: string, productId: string): Promise<string> {
    const brandId = await this.repository.getProductBrandId(tenantId, productId);
    if (brandId === null) {
      throw new CatalogError("PRODUCT_NOT_FOUND");
    }
    return brandId;
  }

  private async requireVariantBrand(tenantId: string, variantId: string): Promise<string> {
    const brandId = await this.repository.getVariantBrandId(tenantId, variantId);
    if (brandId === null) {
      throw new CatalogError("VARIANT_NOT_FOUND");
    }
    return brandId;
  }

  private async requireMediaBrand(tenantId: string, mediaId: string): Promise<string> {
    const brandId = await this.repository.getMediaBrandId(tenantId, mediaId);
    if (brandId === null) {
      throw new CatalogError("MEDIA_NOT_FOUND");
    }
    return brandId;
  }
}
