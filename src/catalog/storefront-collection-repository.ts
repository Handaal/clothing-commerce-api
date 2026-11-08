import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only adapter over the DB-enforced public collection read boundary (`catalog_public`). Like the
 * product boundary, the published-only projection is guaranteed by the SECURITY DEFINER functions, so
 * this repository can never return draft/archived collections or unpublished products regardless of the
 * client role. It exposes only the two sanctioned public functions — no generic table access.
 */
const CATALOG_PUBLIC_SCHEMA = "catalog_public";

export interface StorefrontCollectionRepository {
  listPublishedCollections(tenantId: string, limit: number): Promise<unknown[]>;
  getPublishedCollection(tenantId: string, slug: string): Promise<unknown | null>;
}

export class SupabaseStorefrontCollectionRepository implements StorefrontCollectionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listPublishedCollections(tenantId: string, limit: number): Promise<unknown[]> {
    const { data, error } = await this.client
      .schema(CATALOG_PUBLIC_SCHEMA)
      .rpc("list_published_collections", {
        p_tenant_id: tenantId,
        p_limit: limit,
      });
    if (error) {
      throw new Error("An unexpected public collection read error occurred.");
    }
    const rows = (Array.isArray(data) ? data : []) as ReadonlyArray<{ collection?: unknown }>;
    return rows.map((row) => row.collection);
  }

  async getPublishedCollection(tenantId: string, slug: string): Promise<unknown | null> {
    const { data, error } = await this.client
      .schema(CATALOG_PUBLIC_SCHEMA)
      .rpc("get_published_collection", {
        p_tenant_id: tenantId,
        p_slug: slug,
      });
    if (error) {
      throw new Error("An unexpected public collection read error occurred.");
    }
    const rows = (Array.isArray(data) ? data : []) as ReadonlyArray<{ collection?: unknown }>;
    return rows.length === 0 ? null : (rows[0]?.collection ?? null);
  }
}

export interface SupabaseStorefrontCollectionRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseStorefrontCollectionRepository(
  configuration: SupabaseStorefrontCollectionRepositoryConfiguration,
): SupabaseStorefrontCollectionRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseStorefrontCollectionRepository(client);
}
