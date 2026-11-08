import type { AuthorizedOperationContext } from "../authorization";

/**
 * Server-only catalog write boundary over the sanctioned `catalog_private` functions. Every mutation
 * asserts the authorization proof before privileged access; the brand resolvers are the minimal
 * tenant-scoped reads the service needs to determine the brand resource to authorize against.
 */

export interface CreateProductCommand {
  readonly tenantId: string;
  readonly brandId: string;
  readonly name: string;
  readonly slug: string;
  readonly styleCode: string | null;
  readonly description: string | null;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
}

export interface UpdateProductCommand {
  readonly tenantId: string;
  readonly productId: string;
  readonly name: string;
  readonly slug: string;
  readonly styleCode: string | null;
  readonly description: string | null;
  readonly idempotencyKey: string;
}

export interface SetProductStatusCommand {
  readonly tenantId: string;
  readonly productId: string;
  readonly status: "draft" | "active" | "archived";
  readonly archiveReason: string | null;
  readonly idempotencyKey: string;
}

export interface CreateVariantCommand {
  readonly tenantId: string;
  readonly productId: string;
  readonly sku: string;
  readonly displayName: string | null;
  readonly idempotencyKey: string;
}

export interface SetVariantPriceCommand {
  readonly tenantId: string;
  readonly variantId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly idempotencyKey: string;
}

export interface SetVariantCostCommand {
  readonly tenantId: string;
  readonly variantId: string;
  readonly unitCostMinor: number;
  readonly idempotencyKey: string;
}

export interface PublishProductCommand {
  readonly tenantId: string;
  readonly productId: string;
  readonly idempotencyKey: string;
}

export interface AddProductMediaCommand {
  readonly tenantId: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly bucket: string;
  readonly path: string;
  readonly altText: string | null;
  readonly position: number | null;
  readonly isPrimary: boolean;
  readonly idempotencyKey: string;
}

export interface ArchiveProductMediaCommand {
  readonly tenantId: string;
  readonly mediaId: string;
  readonly idempotencyKey: string;
}

export interface ProductWriteResult {
  readonly productId: string;
  readonly status: "draft" | "active" | "archived";
  readonly storefrontStatus: "unpublished" | "published";
}

export interface PublishResult {
  readonly productId: string;
  readonly storefrontStatus: "published";
  readonly publishedAt: string | null;
}

export interface CatalogWriteRepository {
  getProductBrandId(tenantId: string, productId: string): Promise<string | null>;
  getVariantBrandId(tenantId: string, variantId: string): Promise<string | null>;
  getMediaBrandId(tenantId: string, mediaId: string): Promise<string | null>;

  createProduct(
    proof: AuthorizedOperationContext,
    command: CreateProductCommand,
  ): Promise<ProductWriteResult>;
  updateProduct(
    proof: AuthorizedOperationContext,
    command: UpdateProductCommand,
  ): Promise<{ productId: string }>;
  setProductStatus(
    proof: AuthorizedOperationContext,
    command: SetProductStatusCommand,
  ): Promise<ProductWriteResult>;
  createVariant(
    proof: AuthorizedOperationContext,
    command: CreateVariantCommand,
  ): Promise<{ variantId: string; status: "draft" | "active" | "archived" }>;
  setVariantPrice(
    proof: AuthorizedOperationContext,
    command: SetVariantPriceCommand,
  ): Promise<{ priceId: string; currency: string; amountMinor: number }>;
  setVariantCost(
    proof: AuthorizedOperationContext,
    command: SetVariantCostCommand,
  ): Promise<{ variantId: string; unitCostMinor: number }>;
  publishProduct(
    proof: AuthorizedOperationContext,
    command: PublishProductCommand,
  ): Promise<PublishResult>;
  unpublishProduct(
    proof: AuthorizedOperationContext,
    command: PublishProductCommand,
  ): Promise<{ productId: string; storefrontStatus: "unpublished" }>;
  addProductMedia(
    proof: AuthorizedOperationContext,
    command: AddProductMediaCommand,
  ): Promise<{ mediaId: string; isPrimary: boolean }>;
  archiveProductMedia(
    proof: AuthorizedOperationContext,
    command: ArchiveProductMediaCommand,
  ): Promise<{ mediaId: string }>;
}
