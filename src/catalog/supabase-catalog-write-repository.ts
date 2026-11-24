import type { ProductMediaItem } from "../contracts/management/catalog-images";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import { CatalogError } from "./catalog-errors";
import type {
  AddProductMediaCommand,
  ArchiveProductMediaCommand,
  CatalogWriteRepository,
  CreateProductCommand,
  CreateVariantCommand,
  ProductWriteResult,
  PublishProductCommand,
  PublishResult,
  SetProductStatusCommand,
  SetVariantCostCommand,
  SetVariantOptionsCommand,
  SetVariantPriceCommand,
  UpdateOptionValuesCommand,
  UpdateProductCommand,
} from "./catalog-write-repository";

// The private schema owning the sanctioned catalog write functions. Exposed to PostgREST so the
// service-role client can call the functions by name; execution is gated by the EXECUTE grants
// (service_role only), never by schema exposure. service_role holds catalog DML (provisioned in
// Phase 2A) and the SECURITY INVOKER functions run as it.
const CATALOG_PRIVATE_SCHEMA = "catalog_private";

// A bigint amount that must round-trip through JSON without precision loss (PostgREST may return int8
// as number or string). Prices are JS safe integers in minor units; out-of-range is a transport
// invariant failure surfaced as a generic internal error, never a domain error.
function toSafeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error("Catalog amount is outside the supported application range.");
  }
  return parsed;
}

interface DatabaseErrorLike {
  readonly code?: string;
}

/**
 * Maps a PostgREST/PostgreSQL error to a stable catalog error. Raw SQLSTATEs and database messages
 * never escape this function. An unexpected privilege failure (42501) from the sanctioned path is a
 * server defect, not a client error, so it surfaces as a generic Error.
 */
function mapDatabaseError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "CT001":
      return new CatalogError("PRODUCT_NOT_FOUND");
    case "CT002":
      return new CatalogError("VARIANT_NOT_FOUND");
    case "CT005":
      return new CatalogError("MEDIA_NOT_FOUND");
    case "CT010":
      return new CatalogError("SLUG_CONFLICT");
    case "CT011":
      return new CatalogError("STYLE_CODE_CONFLICT");
    case "CT020":
      return new CatalogError("SKU_CONFLICT");
    case "CT021":
      return new CatalogError("VARIANT_OPTIONS_CONFLICT");
    case "CT022":
      return new CatalogError("OPTION_VALUE_NOT_FOUND");
    case "CT030":
      return new CatalogError("INVALID_LIFECYCLE_TRANSITION");
    case "CT031":
      return new CatalogError("PRODUCT_NOT_PUBLISHABLE");
    case "CT032":
      return new CatalogError("PRODUCT_PUBLISHED");
    case "ID409":
      return new CatalogError("IDEMPOTENCY_CONFLICT");
    case "22004":
    case "22023":
    case "22P02":
    case "22003":
      return new CatalogError("INVALID_INPUT");
    default:
      return new Error("An unexpected catalog persistence error occurred.");
  }
}

const ProductWriteRowSchema = z.object({
  product_id: z.string().uuid(),
  status: z.enum(["draft", "active", "archived"]),
  storefront_status: z.enum(["unpublished", "published"]),
});
const ProductIdRowSchema = z.object({ product_id: z.string().uuid() });
const VariantRowSchema = z.object({
  variant_id: z.string().uuid(),
  status: z.enum(["draft", "active", "archived"]),
});
const VariantOptionsRowSchema = z.object({
  variant_id: z.string().uuid(),
  option_signature: z.string(),
});
const OptionValuesRowSchema = z.object({
  product_id: z.string().uuid(),
  updated_count: z.union([z.number(), z.string()]),
});
const PriceRowSchema = z.object({
  price_id: z.string().uuid(),
  currency: z.string(),
  amount_minor: z.union([z.number(), z.string()]),
});
const CostRowSchema = z.object({
  variant_id: z.string().uuid(),
  unit_cost_minor: z.union([z.number(), z.string()]),
});
const PublishRowSchema = z.object({
  product_id: z.string().uuid(),
  storefront_status: z.literal("published"),
  storefront_published_at: z.string().nullable(),
});
const UnpublishRowSchema = z.object({
  product_id: z.string().uuid(),
  storefront_status: z.literal("unpublished"),
});
const MediaRowSchema = z.object({ media_id: z.string().uuid(), is_primary: z.boolean() });
const MediaIdRowSchema = z.object({ media_id: z.string().uuid() });
const BrandIdRowSchema = z.object({ brand_id: z.string().uuid() });

/**
 * Server-only adapter around a service-role client. The client is deliberately private; this class
 * exposes no generic query/write escape hatch. Every write method asserts the authorization proof
 * before any privileged database access, and every sanctioned function is called by name only.
 */
export class SupabaseCatalogWriteRepository implements CatalogWriteRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getProductBrandId(tenantId: string, productId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("products")
      .select("brand_id")
      .eq("tenant_id", tenantId)
      .eq("id", productId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    return rows.length === 0 ? null : BrandIdRowSchema.parse(rows[0]).brand_id;
  }

  async getVariantBrandId(tenantId: string, variantId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("product_variants")
      .select("products!inner(brand_id)")
      .eq("tenant_id", tenantId)
      .eq("id", variantId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = (data ?? []) as ReadonlyArray<{ products?: { brand_id?: unknown } }>;
    const brandId = rows[0]?.products?.brand_id;
    return typeof brandId === "string" ? brandId : null;
  }

  async getMediaBrandId(tenantId: string, mediaId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("product_media")
      .select("products!inner(brand_id)")
      .eq("tenant_id", tenantId)
      .eq("id", mediaId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = (data ?? []) as ReadonlyArray<{ products?: { brand_id?: unknown } }>;
    const brandId = rows[0]?.products?.brand_id;
    return typeof brandId === "string" ? brandId : null;
  }

  async createProduct(
    proof: AuthorizedOperationContext,
    command: CreateProductCommand,
  ): Promise<ProductWriteResult> {
    assertAuthorizedOperationProof(proof);
    const row = ProductWriteRowSchema.parse(
      await this.callFunction("create_product", {
        p_tenant_id: command.tenantId,
        p_brand_id: command.brandId,
        p_name: command.name,
        p_slug: command.slug,
        p_style_code: command.styleCode,
        p_description: command.description,
        p_actor_membership_id: command.actorMembershipId,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return {
      productId: row.product_id,
      status: row.status,
      storefrontStatus: row.storefront_status,
    };
  }

  async updateProduct(
    proof: AuthorizedOperationContext,
    command: UpdateProductCommand,
  ): Promise<{ productId: string }> {
    assertAuthorizedOperationProof(proof);
    const row = ProductIdRowSchema.parse(
      await this.callFunction("update_product", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_name: command.name,
        p_slug: command.slug,
        p_style_code: command.styleCode,
        p_description: command.description,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { productId: row.product_id };
  }

  async setProductStatus(
    proof: AuthorizedOperationContext,
    command: SetProductStatusCommand,
  ): Promise<ProductWriteResult> {
    assertAuthorizedOperationProof(proof);
    const row = ProductWriteRowSchema.parse(
      await this.callFunction("set_product_status", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_target_status: command.status,
        p_archive_reason: command.archiveReason,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return {
      productId: row.product_id,
      status: row.status,
      storefrontStatus: row.storefront_status,
    };
  }

  async createVariant(
    proof: AuthorizedOperationContext,
    command: CreateVariantCommand,
  ): Promise<{ variantId: string; status: "draft" | "active" | "archived" }> {
    assertAuthorizedOperationProof(proof);
    // Without options keep the original function (and its replay fingerprint); with options use the
    // atomic create-and-select function.
    const row = VariantRowSchema.parse(
      command.options === undefined
        ? await this.callFunction("create_variant", {
            p_tenant_id: command.tenantId,
            p_product_id: command.productId,
            p_sku: command.sku,
            p_display_name: command.displayName,
            p_idempotency_key: command.idempotencyKey,
          })
        : await this.callFunction("create_variant_with_options", {
            p_tenant_id: command.tenantId,
            p_product_id: command.productId,
            p_sku: command.sku,
            p_display_name: command.displayName,
            p_options: command.options.map((option) => ({
              name: option.name,
              value: option.value,
            })),
            p_idempotency_key: command.idempotencyKey,
          }),
    );
    return { variantId: row.variant_id, status: row.status };
  }

  async setVariantOptions(
    proof: AuthorizedOperationContext,
    command: SetVariantOptionsCommand,
  ): Promise<{ variantId: string; optionSignature: string }> {
    assertAuthorizedOperationProof(proof);
    const row = VariantOptionsRowSchema.parse(
      await this.callFunction("set_variant_options", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_variant_id: command.variantId,
        p_options: command.options.map((option) => ({ name: option.name, value: option.value })),
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { variantId: row.variant_id, optionSignature: row.option_signature };
  }

  async updateOptionValues(
    proof: AuthorizedOperationContext,
    command: UpdateOptionValuesCommand,
  ): Promise<{ productId: string; updatedCount: number }> {
    assertAuthorizedOperationProof(proof);
    const row = OptionValuesRowSchema.parse(
      await this.callFunction("update_option_values", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_values: command.values.map((value) => ({
          valueId: value.valueId,
          swatchHex: value.swatchHex === null ? null : value.swatchHex.toLowerCase(),
          ...(value.position !== undefined ? { position: value.position } : {}),
        })),
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { productId: row.product_id, updatedCount: Number(row.updated_count) };
  }

  async setVariantPrice(
    proof: AuthorizedOperationContext,
    command: SetVariantPriceCommand,
  ): Promise<{ priceId: string; currency: string; amountMinor: number }> {
    assertAuthorizedOperationProof(proof);
    const row = PriceRowSchema.parse(
      await this.callFunction("set_variant_price", {
        p_tenant_id: command.tenantId,
        p_variant_id: command.variantId,
        p_currency: command.currency,
        p_amount_minor: command.amountMinor,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return {
      priceId: row.price_id,
      currency: row.currency,
      amountMinor: toSafeInteger(row.amount_minor),
    };
  }

  async setVariantCost(
    proof: AuthorizedOperationContext,
    command: SetVariantCostCommand,
  ): Promise<{ variantId: string; unitCostMinor: number }> {
    assertAuthorizedOperationProof(proof);
    const row = CostRowSchema.parse(
      await this.callFunction("set_variant_cost", {
        p_tenant_id: command.tenantId,
        p_variant_id: command.variantId,
        p_unit_cost_minor: command.unitCostMinor,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return {
      variantId: row.variant_id,
      unitCostMinor: toSafeInteger(row.unit_cost_minor),
    };
  }

  async publishProduct(
    proof: AuthorizedOperationContext,
    command: PublishProductCommand,
  ): Promise<PublishResult> {
    assertAuthorizedOperationProof(proof);
    const row = PublishRowSchema.parse(
      await this.callFunction("publish_product", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return {
      productId: row.product_id,
      storefrontStatus: row.storefront_status,
      // Normalize the Postgres timestamptz (numeric offset form) to a canonical UTC ISO-8601 instant.
      publishedAt:
        row.storefront_published_at === null
          ? null
          : new Date(row.storefront_published_at).toISOString(),
    };
  }

  async unpublishProduct(
    proof: AuthorizedOperationContext,
    command: PublishProductCommand,
  ): Promise<{ productId: string; storefrontStatus: "unpublished" }> {
    assertAuthorizedOperationProof(proof);
    const row = UnpublishRowSchema.parse(
      await this.callFunction("unpublish_product", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { productId: row.product_id, storefrontStatus: row.storefront_status };
  }

  async addProductMedia(
    proof: AuthorizedOperationContext,
    command: AddProductMediaCommand,
  ): Promise<{ mediaId: string; isPrimary: boolean }> {
    assertAuthorizedOperationProof(proof);
    const row = MediaRowSchema.parse(
      await this.callFunction("add_product_media", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_variant_id: command.variantId,
        p_storage_bucket: command.bucket,
        p_storage_path: command.path,
        p_alt_text: command.altText,
        p_position: command.position,
        p_is_primary: command.isPrimary,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { mediaId: row.media_id, isPrimary: row.is_primary };
  }

  async archiveProductMedia(
    proof: AuthorizedOperationContext,
    command: ArchiveProductMediaCommand,
  ): Promise<{ mediaId: string }> {
    assertAuthorizedOperationProof(proof);
    const row = MediaIdRowSchema.parse(
      await this.callFunction("archive_product_media", {
        p_tenant_id: command.tenantId,
        p_media_id: command.mediaId,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { mediaId: row.media_id };
  }

  async listProductMedia(
    proof: AuthorizedOperationContext,
    tenantId: string,
    productId: string,
  ): Promise<ProductMediaItem[]> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("product_media")
      .select("id, variant_id, storage_bucket, storage_path, alt_text, position, is_primary")
      .eq("tenant_id", tenantId)
      .eq("product_id", productId)
      .eq("status", "active")
      .order("is_primary", { ascending: false })
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      throw mapDatabaseError(error);
    }
    const Row = z.object({
      id: z.string().uuid(),
      variant_id: z.string().uuid().nullable(),
      storage_bucket: z.string(),
      storage_path: z.string(),
      alt_text: z.string().nullable(),
      position: z.number().int(),
      is_primary: z.boolean(),
    });
    return (data ?? []).map((raw) => {
      const row = Row.parse(raw);
      return {
        id: row.id,
        variantId: row.variant_id,
        bucket: row.storage_bucket,
        path: row.storage_path,
        altText: row.alt_text,
        position: Math.max(0, row.position),
        isPrimary: row.is_primary,
      };
    });
  }

  async updateProductMedia(
    proof: AuthorizedOperationContext,
    command: {
      tenantId: string;
      mediaId: string;
      setAlt: boolean;
      altText: string | null;
      makePrimary: boolean;
    },
  ) {
    assertAuthorizedOperationProof(proof);
    const row = z
      .object({
        media_id: z.string().uuid(),
        is_primary: z.boolean(),
        alt_text: z.string().nullable(),
      })
      .parse(
        await this.callFunction("update_product_media", {
          p_tenant_id: command.tenantId,
          p_media_id: command.mediaId,
          p_set_alt: command.setAlt,
          p_alt_text: command.altText,
          p_make_primary: command.makePrimary,
        }),
      );
    return { mediaId: row.media_id, isPrimary: row.is_primary, altText: row.alt_text };
  }

  async reorderProductMedia(
    proof: AuthorizedOperationContext,
    command: { tenantId: string; productId: string; mediaIds: string[] },
  ) {
    assertAuthorizedOperationProof(proof);
    const row = z.object({ product_id: z.string().uuid(), media_count: z.number().int() }).parse(
      await this.callFunction("reorder_product_media", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_media_ids: command.mediaIds,
      }),
    );
    return { productId: row.product_id, mediaCount: row.media_count };
  }

  private async callFunction(
    functionName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const { data, error } = await this.client
      .schema(CATALOG_PRIVATE_SCHEMA)
      .rpc(functionName, params);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0 || rows[0] === null || rows[0] === undefined) {
      throw new Error(`Catalog function ${functionName} returned no result row.`);
    }
    return rows[0];
  }
}

export interface SupabaseCatalogWriteRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseCatalogWriteRepository(
  configuration: SupabaseCatalogWriteRepositoryConfiguration,
): SupabaseCatalogWriteRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseCatalogWriteRepository(client);
}
