import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  DeleteSaleResponseSchema,
  SaleListResponseSchema,
  SaleSchema,
  type CreateSaleRequest,
  type UpdateSaleRequest,
} from "../contracts/management/sales";
import {
  StorefrontContentSchema,
  type UpdateStorefrontContentRequest,
} from "../contracts/management/storefront-content";
import { StorefrontSiteTextSchema, type SiteText } from "../contracts/storefront/site-text";
import { MerchandisingError, merchandisingDatabaseError } from "./errors";

/**
 * Transport over the sanctioned catalog merchandising RPCs (catalog_private.*_sale,
 * *_storefront_content, catalog_public.get_storefront_content). service_role is DB transport only: it
 * holds SELECT on the tables and EXECUTE on these functions; authorization already happened in the
 * service and is proven by the AuthorizedOperationContext.
 */
const PRIVATE = "catalog_private";
const PUBLIC = "catalog_public";

export class MerchandisingRepository {
  constructor(private readonly client: SupabaseClient) {}

  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }

  private sale(data: unknown) {
    if (data === null || data === undefined) throw new MerchandisingError("SALE_NOT_FOUND");
    return SaleSchema.parse(data);
  }

  // ---- Sales ----
  async listSales(proof: AuthorizedOperationContext) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("list_sales", { p_tenant: this.tenant(proof) });
    if (error) throw merchandisingDatabaseError(error, "INVALID_SALE");
    return SaleListResponseSchema.parse(data);
  }

  async getSale(proof: AuthorizedOperationContext, id: string) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("sale_detail", { p_tenant: this.tenant(proof), p_id: id });
    if (error) throw merchandisingDatabaseError(error, "INVALID_SALE");
    return this.sale(data);
  }

  async createSale(proof: AuthorizedOperationContext, key: string, payload: CreateSaleRequest) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("create_sale", { p_tenant: this.tenant(proof), p_key: key, p_payload: payload });
    if (error) throw merchandisingDatabaseError(error, "INVALID_SALE");
    return this.sale(data);
  }

  async updateSale(proof: AuthorizedOperationContext, id: string, payload: UpdateSaleRequest) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("update_sale", { p_tenant: this.tenant(proof), p_id: id, p_payload: payload });
    if (error) throw merchandisingDatabaseError(error, "INVALID_SALE");
    return this.sale(data);
  }

  async setSaleStatus(
    proof: AuthorizedOperationContext,
    id: string,
    status: "active" | "inactive",
  ) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("set_sale_status", { p_tenant: this.tenant(proof), p_id: id, p_status: status });
    if (error) throw merchandisingDatabaseError(error, "INVALID_SALE");
    return this.sale(data);
  }

  async deleteSale(proof: AuthorizedOperationContext, id: string) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("delete_sale", { p_tenant: this.tenant(proof), p_id: id });
    if (error) throw merchandisingDatabaseError(error, "INVALID_SALE");
    return DeleteSaleResponseSchema.parse(data);
  }

  // ---- Storefront content ----
  async getStorefrontContent(proof: AuthorizedOperationContext) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("storefront_content_detail", { p_tenant: this.tenant(proof) });
    if (error) throw merchandisingDatabaseError(error, "INVALID_STOREFRONT_CONTENT");
    // A tenant that never saved content has no row: the RPC's left join yields null id arrays. Treat
    // that as "nothing featured yet" instead of failing the editor's first load with a 500.
    const row = (data ?? {}) as Record<string, unknown>;
    return StorefrontContentSchema.parse({
      ...row,
      featuredProductIds: row.featuredProductIds ?? [],
      featuredCollectionIds: row.featuredCollectionIds ?? [],
    });
  }

  async updateStorefrontContent(
    proof: AuthorizedOperationContext,
    payload: UpdateStorefrontContentRequest,
  ) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("upsert_storefront_content", { p_tenant: this.tenant(proof), p_payload: payload });
    if (error) throw merchandisingDatabaseError(error, "INVALID_STOREFRONT_CONTENT");
    return StorefrontContentSchema.parse(data);
  }

  // ---- Storefront site text (SDK 0.52) ----
  async getStorefrontSiteText(proof: AuthorizedOperationContext) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("storefront_site_text_detail", { p_tenant: this.tenant(proof) });
    if (error) throw merchandisingDatabaseError(error, "INVALID_STOREFRONT_CONTENT");
    return StorefrontSiteTextSchema.parse(data);
  }

  async updateStorefrontSiteText(proof: AuthorizedOperationContext, document: SiteText) {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("upsert_storefront_site_text", { p_tenant: this.tenant(proof), p_document: document });
    if (error) throw merchandisingDatabaseError(error, "INVALID_STOREFRONT_CONTENT");
    return StorefrontSiteTextSchema.parse(data);
  }

  /** PUBLIC read: no proof — the DB function only answers for an active tenant. */
  async getPublicStorefrontSiteText(tenantId: string): Promise<unknown> {
    const { data, error } = await this.client
      .schema(PRIVATE)
      .rpc("public_storefront_site_text", { p_tenant: tenantId });
    if (error) throw new Error("An unexpected public storefront site text read error occurred.");
    return data;
  }

  /** PUBLIC read: no proof — the DB function itself is the published-only boundary. */
  async getPublicStorefrontContent(tenantId: string, brandId: string | null): Promise<unknown> {
    const { data, error } = await this.client
      .schema(PUBLIC)
      .rpc("get_storefront_content", { p_tenant_id: tenantId, p_brand_id: brandId });
    if (error) throw new Error("An unexpected public storefront content read error occurred.");
    return data;
  }
}

export function createMerchandisingRepository(configuration: {
  url: string;
  serviceRoleKey: string;
}) {
  return new MerchandisingRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
