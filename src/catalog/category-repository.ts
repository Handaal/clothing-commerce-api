import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { CatalogImageInput } from "../contracts/management/catalog-images";
import { imageFromColumns } from "./catalog-image";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import type { CategoryStatus, CategorySummary } from "../contracts/management/categories";
import type { SizeGuide } from "../contracts/storefront/catalog";
import { CatalogError } from "./catalog-errors";
import { shapeSizeGuide } from "./public-product-shape";

const CATALOG_PRIVATE_SCHEMA = "catalog_private";
const CATALOG_PUBLIC_SCHEMA = "catalog_public";

export interface CreateCategoryCommand {
  tenantId: string;
  parentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  position: number | null;
  idempotencyKey: string;
}
export interface UpdateCategoryCommand extends CreateCategoryCommand {
  categoryId: string;
}
export interface SetCategoryStatusCommand {
  tenantId: string;
  categoryId: string;
  status: CategoryStatus;
  archiveReason: string | null;
  idempotencyKey: string;
}
export interface SetProductCategoriesCommand {
  tenantId: string;
  productId: string;
  categoryIds: string[];
  idempotencyKey: string;
}

export interface SetCategorySizeGuideCommand {
  tenantId: string;
  categoryId: string;
  sizeGuide: SizeGuide | null;
  idempotencyKey: string;
}

export interface CategoryRepository {
  listCategories(proof: AuthorizedOperationContext, tenantId: string): Promise<CategorySummary[]>;
  createCategory(
    proof: AuthorizedOperationContext,
    command: CreateCategoryCommand,
  ): Promise<{ categoryId: string; status: CategoryStatus }>;
  updateCategory(
    proof: AuthorizedOperationContext,
    command: UpdateCategoryCommand,
  ): Promise<{ categoryId: string }>;
  setCategoryStatus(
    proof: AuthorizedOperationContext,
    command: SetCategoryStatusCommand,
  ): Promise<{ categoryId: string; status: CategoryStatus }>;
  setProductCategories(
    proof: AuthorizedOperationContext,
    command: SetProductCategoriesCommand,
  ): Promise<{ productId: string; categoryCount: number }>;
  setCategorySizeGuide(
    proof: AuthorizedOperationContext,
    command: SetCategorySizeGuideCommand,
  ): Promise<{ categoryId: string; hasSizeGuide: boolean }>;
  /** Public, published-only category list (DB-enforced projection). */
  listStorefrontCategories(tenantId: string): Promise<unknown[]>;
  /** SDK 0.53: set or clear (null) the category's website image. */
  setCategoryImage(
    proof: AuthorizedOperationContext,
    command: { tenantId: string; categoryId: string; image: CatalogImageInput | null },
  ): Promise<{ categoryId: string; hasImage: boolean }>;
}

interface DatabaseErrorLike {
  readonly code?: string;
}

function mapDatabaseError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "CT001":
      return new CatalogError("PRODUCT_NOT_FOUND");
    case "CT050":
      return new CatalogError("CATEGORY_NOT_FOUND");
    case "CT051":
      return new CatalogError("CATEGORY_CYCLE");
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
      return new Error("An unexpected category persistence error occurred.");
  }
}

const CategoryRowSchema = z.object({
  id: z.string().uuid(),
  parent_category_id: z.string().uuid().nullable(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  position: z.number().int(),
  status: z.enum(["active", "archived"]),
  size_guide: z.unknown().optional(),
  image_bucket: z.string().nullable().optional(),
  image_path: z.string().nullable().optional(),
  image_alt: z.string().nullable().optional(),
  product_categories: z.array(z.object({ count: z.number() })).optional(),
});
const SizeGuideRowSchema = z.object({
  category_id: z.string().uuid(),
  has_size_guide: z.boolean(),
});
const CreateRowSchema = z.object({
  category_id: z.string().uuid(),
  status: z.enum(["active", "archived"]),
});
const UpdateRowSchema = z.object({ category_id: z.string().uuid() });
const MembershipRowSchema = z.object({
  product_id: z.string().uuid(),
  category_count: z.union([z.number(), z.string()]),
});

/**
 * Server-only adapter around a service-role client. Reads select directly (service_role holds SELECT on
 * the merchandising tables); writes call the sanctioned catalog_private functions. Every management
 * method asserts the authorization proof before privileged access; the public list goes through the
 * published-only catalog_public function.
 */
export class SupabaseCategoryRepository implements CategoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listCategories(
    proof: AuthorizedOperationContext,
    tenantId: string,
  ): Promise<CategorySummary[]> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("categories")
      .select(
        "id, parent_category_id, name, slug, description, position, status, size_guide, image_bucket, image_path, image_alt, product_categories(count)",
      )
      .eq("tenant_id", tenantId)
      .order("position", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      throw mapDatabaseError(error);
    }
    return (data ?? []).map((raw) => {
      const row = CategoryRowSchema.parse(raw);
      return {
        id: row.id,
        parentId: row.parent_category_id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        position: row.position,
        status: row.status,
        productCount: row.product_categories?.[0]?.count ?? 0,
        sizeGuide: shapeSizeGuide(row.size_guide),
        image: imageFromColumns(row.image_bucket, row.image_path, row.image_alt),
      };
    });
  }

  async createCategory(proof: AuthorizedOperationContext, command: CreateCategoryCommand) {
    assertAuthorizedOperationProof(proof);
    const row = CreateRowSchema.parse(
      await this.callFunction("create_category", {
        p_tenant_id: command.tenantId,
        p_parent_category_id: command.parentId,
        p_name: command.name,
        p_slug: command.slug,
        p_description: command.description,
        p_position: command.position,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { categoryId: row.category_id, status: row.status };
  }

  async updateCategory(proof: AuthorizedOperationContext, command: UpdateCategoryCommand) {
    assertAuthorizedOperationProof(proof);
    const row = UpdateRowSchema.parse(
      await this.callFunction("update_category", {
        p_tenant_id: command.tenantId,
        p_category_id: command.categoryId,
        p_parent_category_id: command.parentId,
        p_name: command.name,
        p_slug: command.slug,
        p_description: command.description,
        p_position: command.position,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { categoryId: row.category_id };
  }

  async setCategoryStatus(proof: AuthorizedOperationContext, command: SetCategoryStatusCommand) {
    assertAuthorizedOperationProof(proof);
    const row = CreateRowSchema.parse(
      await this.callFunction("set_category_status", {
        p_tenant_id: command.tenantId,
        p_category_id: command.categoryId,
        p_target_status: command.status,
        p_archive_reason: command.archiveReason,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { categoryId: row.category_id, status: row.status };
  }

  async setProductCategories(
    proof: AuthorizedOperationContext,
    command: SetProductCategoriesCommand,
  ) {
    assertAuthorizedOperationProof(proof);
    const row = MembershipRowSchema.parse(
      await this.callFunction("set_product_categories", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_category_ids: command.categoryIds,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { productId: row.product_id, categoryCount: Number(row.category_count) };
  }

  async setCategorySizeGuide(
    proof: AuthorizedOperationContext,
    command: SetCategorySizeGuideCommand,
  ) {
    assertAuthorizedOperationProof(proof);
    const row = SizeGuideRowSchema.parse(
      await this.callFunction("set_category_size_guide", {
        p_tenant_id: command.tenantId,
        p_category_id: command.categoryId,
        p_size_guide: command.sizeGuide,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { categoryId: row.category_id, hasSizeGuide: row.has_size_guide };
  }

  async setCategoryImage(
    proof: AuthorizedOperationContext,
    command: { tenantId: string; categoryId: string; image: CatalogImageInput | null },
  ) {
    assertAuthorizedOperationProof(proof);
    const row = z.object({ category_id: z.string().uuid(), has_image: z.boolean() }).parse(
      await this.callFunction("set_category_image", {
        p_tenant_id: command.tenantId,
        p_category_id: command.categoryId,
        p_bucket: command.image?.bucket ?? null,
        p_path: command.image?.path ?? null,
        p_alt: command.image?.altText ?? null,
      }),
    );
    return { categoryId: row.category_id, hasImage: row.has_image };
  }

  async listStorefrontCategories(tenantId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .schema(CATALOG_PUBLIC_SCHEMA)
      .rpc("list_storefront_categories", { p_tenant_id: tenantId });
    if (error) {
      throw new Error("An unexpected public category read error occurred.");
    }
    const rows = (Array.isArray(data) ? data : []) as ReadonlyArray<{ category?: unknown }>;
    return rows.map((row) => row.category);
  }

  private async callFunction(name: string, params: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.schema(CATALOG_PRIVATE_SCHEMA).rpc(name, params);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0 || rows[0] === null || rows[0] === undefined) {
      throw new Error(`Category function ${name} returned no result row.`);
    }
    return rows[0];
  }
}

export function createSupabaseCategoryRepository(configuration: {
  readonly url: string;
  readonly serviceRoleKey: string;
}): SupabaseCategoryRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseCategoryRepository(client);
}
