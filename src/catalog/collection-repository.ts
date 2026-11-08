import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import type {
  CollectionDetailResponse,
  CollectionStatus,
  CollectionSummary,
} from "../contracts/management/collections";
import { CatalogError } from "./catalog-errors";

const CATALOG_PRIVATE_SCHEMA = "catalog_private";

export interface CreateCollectionCommand {
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  actorMembershipId: string;
  idempotencyKey: string;
}
export interface UpdateCollectionCommand {
  tenantId: string;
  collectionId: string;
  name: string;
  slug: string;
  description: string | null;
  idempotencyKey: string;
}
export interface SetCollectionStatusCommand {
  tenantId: string;
  collectionId: string;
  status: CollectionStatus;
  archiveReason: string | null;
  idempotencyKey: string;
}
export interface SetCollectionProductsCommand {
  tenantId: string;
  collectionId: string;
  productIds: string[];
  idempotencyKey: string;
}

export interface CollectionRepository {
  listCollections(
    proof: AuthorizedOperationContext,
    tenantId: string,
  ): Promise<CollectionSummary[]>;
  getCollection(
    proof: AuthorizedOperationContext,
    tenantId: string,
    collectionId: string,
  ): Promise<CollectionDetailResponse>;
  createCollection(
    proof: AuthorizedOperationContext,
    command: CreateCollectionCommand,
  ): Promise<{ collectionId: string; status: CollectionStatus }>;
  updateCollection(
    proof: AuthorizedOperationContext,
    command: UpdateCollectionCommand,
  ): Promise<{ collectionId: string }>;
  setCollectionStatus(
    proof: AuthorizedOperationContext,
    command: SetCollectionStatusCommand,
  ): Promise<{ collectionId: string; status: CollectionStatus }>;
  setCollectionProducts(
    proof: AuthorizedOperationContext,
    command: SetCollectionProductsCommand,
  ): Promise<{ collectionId: string; productCount: number }>;
}

interface DatabaseErrorLike {
  readonly code?: string;
}

// The sanctioned collection functions raise CT-prefixed / ID409 signals; map them to stable domain
// errors. Raw SQLSTATEs never escape this adapter.
function mapDatabaseError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "CT001":
      return new CatalogError("PRODUCT_NOT_FOUND");
    case "CT040":
      return new CatalogError("COLLECTION_NOT_FOUND");
    case "CT010":
      return new CatalogError("SLUG_CONFLICT");
    case "ID409":
      return new CatalogError("IDEMPOTENCY_CONFLICT");
    case "22004":
    case "22023":
    case "22P02":
    case "22003":
      return new CatalogError("INVALID_INPUT");
    default:
      return new Error("An unexpected collection persistence error occurred.");
  }
}

const CollectionRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.enum(["draft", "active", "archived"]),
});
const CreateRowSchema = z.object({
  collection_id: z.string().uuid(),
  status: z.enum(["draft", "active", "archived"]),
});
const UpdateRowSchema = z.object({ collection_id: z.string().uuid() });
const SetProductsRowSchema = z.object({
  collection_id: z.string().uuid(),
  product_count: z.union([z.number(), z.string()]),
});

/**
 * Server-only adapter around a service-role client. Reads select directly (service_role holds SELECT on
 * the merchandising tables); writes call the sanctioned catalog_private functions by name. Every method
 * asserts the authorization proof before any privileged database access.
 */
export class SupabaseCollectionRepository implements CollectionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listCollections(
    proof: AuthorizedOperationContext,
    tenantId: string,
  ): Promise<CollectionSummary[]> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("collections")
      .select("id, name, slug, description, status, product_collections(count)")
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false });
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = (data ?? []) as ReadonlyArray<
      z.infer<typeof CollectionRowSchema> & {
        product_collections?: ReadonlyArray<{ count?: number }>;
      }
    >;
    return rows.map((row) => {
      const parsed = CollectionRowSchema.parse(row);
      return {
        id: parsed.id,
        name: parsed.name,
        slug: parsed.slug,
        description: parsed.description,
        status: parsed.status,
        productCount: row.product_collections?.[0]?.count ?? 0,
      };
    });
  }

  async getCollection(
    proof: AuthorizedOperationContext,
    tenantId: string,
    collectionId: string,
  ): Promise<CollectionDetailResponse> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("collections")
      .select("id, name, slug, description, status")
      .eq("tenant_id", tenantId)
      .eq("id", collectionId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      throw new CatalogError("COLLECTION_NOT_FOUND");
    }
    const collection = CollectionRowSchema.parse(rows[0]);

    const membership = await this.client
      .from("product_collections")
      .select("product_id, position")
      .eq("tenant_id", tenantId)
      .eq("collection_id", collectionId)
      .order("position", { ascending: true });
    if (membership.error) {
      throw mapDatabaseError(membership.error);
    }
    const productIds = (membership.data ?? [])
      .map((row) => (row as { product_id?: unknown }).product_id)
      .filter((value): value is string => typeof value === "string");

    return {
      collection: {
        id: collection.id,
        name: collection.name,
        slug: collection.slug,
        description: collection.description,
        status: collection.status,
        productCount: productIds.length,
      },
      productIds,
    };
  }

  async createCollection(proof: AuthorizedOperationContext, command: CreateCollectionCommand) {
    assertAuthorizedOperationProof(proof);
    const row = CreateRowSchema.parse(
      await this.callFunction("create_collection", {
        p_tenant_id: command.tenantId,
        p_name: command.name,
        p_slug: command.slug,
        p_description: command.description,
        p_actor_membership_id: command.actorMembershipId,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { collectionId: row.collection_id, status: row.status };
  }

  async updateCollection(proof: AuthorizedOperationContext, command: UpdateCollectionCommand) {
    assertAuthorizedOperationProof(proof);
    const row = UpdateRowSchema.parse(
      await this.callFunction("update_collection", {
        p_tenant_id: command.tenantId,
        p_collection_id: command.collectionId,
        p_name: command.name,
        p_slug: command.slug,
        p_description: command.description,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { collectionId: row.collection_id };
  }

  async setCollectionStatus(
    proof: AuthorizedOperationContext,
    command: SetCollectionStatusCommand,
  ) {
    assertAuthorizedOperationProof(proof);
    const row = CreateRowSchema.parse(
      await this.callFunction("set_collection_status", {
        p_tenant_id: command.tenantId,
        p_collection_id: command.collectionId,
        p_target_status: command.status,
        p_archive_reason: command.archiveReason,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { collectionId: row.collection_id, status: row.status };
  }

  async setCollectionProducts(
    proof: AuthorizedOperationContext,
    command: SetCollectionProductsCommand,
  ) {
    assertAuthorizedOperationProof(proof);
    const row = SetProductsRowSchema.parse(
      await this.callFunction("set_collection_products", {
        p_tenant_id: command.tenantId,
        p_collection_id: command.collectionId,
        p_product_ids: command.productIds,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    const count =
      typeof row.product_count === "string" ? Number(row.product_count) : row.product_count;
    return { collectionId: row.collection_id, productCount: count };
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
      throw new Error(`Collection function ${functionName} returned no result row.`);
    }
    return rows[0];
  }
}

export interface SupabaseCollectionRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseCollectionRepository(
  configuration: SupabaseCollectionRepositoryConfiguration,
): SupabaseCollectionRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseCollectionRepository(client);
}
