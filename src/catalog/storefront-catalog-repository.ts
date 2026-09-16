import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only adapter over the DB-enforced public read boundary (`catalog_public`). The published-only
 * projection is guaranteed by the SECURITY DEFINER functions themselves, so this repository can never
 * return unpublished or internal data regardless of the client role. The wrapped client is private and
 * exposes only the two sanctioned public functions — no generic table access. (Binding this boundary to
 * the anon key instead of service_role is a trivial future hardening; the function is the boundary.)
 */
const CATALOG_PUBLIC_SCHEMA = "catalog_public";

export interface StorefrontCatalogRepository {
  listPublishedProducts(
    tenantId: string,
    brandId: string | null,
    limit: number,
  ): Promise<unknown[]>;
  getPublishedProduct(tenantId: string, slug: string): Promise<unknown | null>;
}

export class SupabaseStorefrontCatalogRepository implements StorefrontCatalogRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listPublishedProducts(
    tenantId: string,
    brandId: string | null,
    limit: number,
  ): Promise<unknown[]> {
    const { data, error } = await this.client
      .schema(CATALOG_PUBLIC_SCHEMA)
      .rpc("list_published_products", {
        p_tenant_id: tenantId,
        p_brand_id: brandId,
        p_limit: limit,
      });
    if (error) {
      throw new Error("An unexpected public catalog read error occurred.");
    }
    const rows = (Array.isArray(data) ? data : []) as ReadonlyArray<{ product?: unknown }>;
    return rows.map((row) => row.product);
  }

  async getPublishedProduct(tenantId: string, slug: string): Promise<unknown | null> {
    const { data, error } = await this.client
      .schema(CATALOG_PUBLIC_SCHEMA)
      .rpc("get_published_product", {
        p_tenant_id: tenantId,
        p_slug: slug,
      });
    if (error) {
      throw new Error("An unexpected public catalog read error occurred.");
    }
    const rows = (Array.isArray(data) ? data : []) as ReadonlyArray<{ product?: unknown }>;
    return rows.length === 0 ? null : (rows[0]?.product ?? null);
  }
}

export interface SupabaseStorefrontCatalogRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseStorefrontCatalogRepository(
  configuration: SupabaseStorefrontCatalogRepositoryConfiguration,
): SupabaseStorefrontCatalogRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseStorefrontCatalogRepository(client);
}
