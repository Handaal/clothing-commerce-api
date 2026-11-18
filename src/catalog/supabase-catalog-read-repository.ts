import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ProductDetailResponse } from "../contracts";
import { normalizeTimestampUtc, toSafeInteger } from "../management/db-serialization";
import type {
  CatalogReadRepository,
  ProductListQuery,
  ProductListRow,
} from "./catalog-read-repository";

const ProductStatus = z.enum(["draft", "active", "archived"]);

const ProductListRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  style_code: z.string().nullable(),
  status: ProductStatus,
  brand_id: z.string().uuid(),
  created_at: z.string().min(1),
});

const IdRowSchema = z.object({ id: z.string().uuid() });
const BrandIdRowSchema = z.object({ brand_id: z.string().uuid() });

const ProductRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  style_code: z.string().nullable(),
  status: ProductStatus,
  brand_id: z.string().uuid(),
});

const VariantRowSchema = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  display_name: z.string().nullable(),
  status: ProductStatus,
});
const BarcodeRowSchema = z.object({ variant_id: z.string().uuid(), value: z.string() });

const OptionRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  position: z.number().int(),
});

const OptionValueRowSchema = z.object({
  id: z.string().uuid(),
  option_id: z.string().uuid(),
  display_value: z.string(),
  position: z.number().int(),
  swatch_hex: z.string().nullable().optional(),
});

const VariantSelectionRowSchema = z.object({
  variant_id: z.string().uuid(),
  option_id: z.string().uuid(),
  option_value_id: z.string().uuid(),
});

const ProductCategoryRowSchema = z.object({ category_id: z.string().uuid() });

const PriceRowSchema = z.object({
  variant_id: z.string().uuid(),
  currency: z.string(),
  amount_minor: z.union([z.number(), z.string()]),
});

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error("Catalog read row failed validation.");
  }
  return parsed.data;
}

function requireNoQueryError(error: unknown): void {
  if (error) {
    throw new Error("An unexpected catalog read query error occurred.");
  }
}

export class SupabaseCatalogReadRepository implements CatalogReadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async brandExistsInTenant(tenantId: string, brandId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("brands")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", brandId)
      .limit(1);
    requireNoQueryError(error);
    return parseRows(IdRowSchema, data).length === 1;
  }

  async listProducts(query: ProductListQuery): Promise<ProductListRow[]> {
    let request = this.client
      .from("products")
      .select("id,name,style_code,status,brand_id,created_at")
      .eq("tenant_id", query.tenantId);

    // Visibility predicate FIRST (before order/cursor/limit). For an explicit grant the caller may only
    // ever see authorized brands; the service guarantees a non-empty brand set when it reaches here.
    if (!query.visibility.tenantWide) {
      request = request.in("brand_id", [...query.visibility.brandIds]);
    }
    if (query.filters.brandId !== undefined) {
      request = request.eq("brand_id", query.filters.brandId);
    }
    if (query.filters.status !== undefined) {
      request = request.eq("status", query.filters.status);
    }
    if (query.cursor !== null) {
      const { createdAt, id } = query.cursor;
      request = request.or(
        `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`,
      );
    }

    const { data, error } = await request
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.fetchLimit);
    requireNoQueryError(error);

    return parseRows(ProductListRowSchema, data).map((row) => ({
      summary: {
        id: row.id,
        name: row.name,
        styleCode: row.style_code,
        status: row.status,
        brandId: row.brand_id,
      },
      cursor: { createdAt: normalizeTimestampUtc(row.created_at), id: row.id },
    }));
  }

  async findProductBrandId(tenantId: string, productId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("products")
      .select("brand_id")
      .eq("tenant_id", tenantId)
      .eq("id", productId)
      .limit(2);
    requireNoQueryError(error);
    const rows = parseRows(BrandIdRowSchema, data);
    return rows.length === 1 ? rows[0].brand_id : null;
  }

  async loadProductDetail(
    tenantId: string,
    productId: string,
  ): Promise<ProductDetailResponse | null> {
    const { data: productData, error: productError } = await this.client
      .from("products")
      .select("id,name,style_code,status,brand_id")
      .eq("tenant_id", tenantId)
      .eq("id", productId)
      .limit(2);
    requireNoQueryError(productError);
    const productRows = parseRows(ProductRowSchema, productData);
    if (productRows.length !== 1) {
      return null;
    }
    const product = productRows[0];

    const [variantResult, optionResult, optionValueResult, selectionResult, categoryResult] =
      await Promise.all([
        this.client
          .from("product_variants")
          .select("id,sku,display_name,status")
          .eq("tenant_id", tenantId)
          .eq("product_id", productId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
        this.client
          .from("product_options")
          .select("id,name,position")
          .eq("tenant_id", tenantId)
          .eq("product_id", productId)
          .eq("status", "active")
          .order("position", { ascending: true })
          .order("id", { ascending: true }),
        this.client
          .from("product_option_values")
          .select("id,option_id,display_value,position,swatch_hex")
          .eq("tenant_id", tenantId)
          .eq("product_id", productId)
          .eq("status", "active")
          .order("position", { ascending: true })
          .order("id", { ascending: true }),
        this.client
          .from("variant_option_values")
          .select("variant_id,option_id,option_value_id")
          .eq("tenant_id", tenantId)
          .eq("product_id", productId),
        this.client
          .from("product_categories")
          .select("category_id")
          .eq("tenant_id", tenantId)
          .eq("product_id", productId),
      ]);
    requireNoQueryError(selectionResult.error);
    requireNoQueryError(categoryResult.error);
    const selectionsByVariant = new Map<string, { optionId: string; valueId: string }[]>();
    for (const row of parseRows(VariantSelectionRowSchema, selectionResult.data)) {
      const bucket = selectionsByVariant.get(row.variant_id) ?? [];
      bucket.push({ optionId: row.option_id, valueId: row.option_value_id });
      selectionsByVariant.set(row.variant_id, bucket);
    }
    const categoryIds = parseRows(ProductCategoryRowSchema, categoryResult.data).map(
      (row) => row.category_id,
    );
    requireNoQueryError(variantResult.error);
    requireNoQueryError(optionResult.error);
    requireNoQueryError(optionValueResult.error);

    const variants = parseRows(VariantRowSchema, variantResult.data);
    const options = parseRows(OptionRowSchema, optionResult.data);
    const optionValues = parseRows(OptionValueRowSchema, optionValueResult.data);

    const variantIds = variants.map((variant) => variant.id);
    const barcodeResult =
      variantIds.length > 0
        ? await this.client
            .from("variant_barcodes")
            .select("variant_id,value")
            .eq("tenant_id", tenantId)
            .in("variant_id", variantIds)
            .eq("is_primary", true)
            .eq("status", "active")
        : { data: [], error: null };
    requireNoQueryError(barcodeResult.error);
    const barcodes = new Map(
      parseRows(BarcodeRowSchema, barcodeResult.data).map((row) => [row.variant_id, row.value]),
    );
    const prices = await this.loadActivePrices(tenantId, variantIds);

    const valuesByOption = new Map<
      string,
      { id: string; value: string; swatchHex: string | null; position: number }[]
    >();
    for (const value of optionValues) {
      const bucket = valuesByOption.get(value.option_id) ?? [];
      bucket.push({
        id: value.id,
        value: value.display_value,
        swatchHex: value.swatch_hex ?? null,
        position: value.position,
      });
      valuesByOption.set(value.option_id, bucket);
    }

    return {
      product: {
        id: product.id,
        name: product.name,
        styleCode: product.style_code,
        status: product.status,
        brandId: product.brand_id,
      },
      variants: variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        barcode: barcodes.get(variant.id) ?? null,
        displayName: variant.display_name,
        status: variant.status,
        optionValues: selectionsByVariant.get(variant.id) ?? [],
      })),
      options: options.map((option) => ({
        id: option.id,
        name: option.name,
        values: valuesByOption.get(option.id) ?? [],
      })),
      prices,
      categoryIds,
    };
  }

  private async loadActivePrices(tenantId: string, variantIds: readonly string[]) {
    if (variantIds.length === 0) {
      return [];
    }
    const { data, error } = await this.client
      .from("variant_prices")
      .select("variant_id,currency,amount_minor")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .in("variant_id", [...variantIds])
      .order("variant_id", { ascending: true })
      .order("currency", { ascending: true });
    requireNoQueryError(error);
    return parseRows(PriceRowSchema, data).map((row) => ({
      variantId: row.variant_id,
      currency: row.currency,
      amountMinor: toSafeInteger(row.amount_minor),
    }));
  }
}

export interface SupabaseCatalogReadRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseCatalogReadRepository(
  configuration: SupabaseCatalogReadRepositoryConfiguration,
): SupabaseCatalogReadRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseCatalogReadRepository(client);
}
