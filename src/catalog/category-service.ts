import { z } from "zod";

import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import type { CategoryListResponse, CategoryStatus } from "../contracts/management/categories";
import type { PublicCategoryListResponse } from "../contracts/storefront/catalog";
import { IntegerLikeSchema } from "./public-product-shape";
import type { CategoryRepository } from "./category-repository";

/**
 * Categories are tenant-wide (no brand scope), like collections, so management authorizes the
 * existing catalog.author permission tenant-wide. Mutation safety (idempotency, slug conflicts, cycle
 * rejection, membership integrity) lives in the sanctioned DB functions.
 */
export const CategoryPermission = { author: "catalog.author" } as const;

export interface CategoryInput {
  parentId?: string | null;
  name: string;
  slug: string;
  description?: string;
  position?: number;
}

const DbPublicCategorySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  position: IntegerLikeSchema,
  productCount: IntegerLikeSchema,
});

export class CategoryService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: CategoryRepository,
  ) {}

  private authorize(context: AuthorizationContext) {
    return this.authorization.authorize(context, { permissionKey: CategoryPermission.author });
  }

  async listCategories(context: AuthorizationContext): Promise<CategoryListResponse> {
    const proof = await this.authorize(context);
    return { categories: await this.repository.listCategories(proof, context.tenant.id) };
  }

  async createCategory(
    context: AuthorizationContext,
    idempotencyKey: string,
    input: CategoryInput,
  ) {
    const proof = await this.authorize(context);
    return this.repository.createCategory(proof, {
      tenantId: context.tenant.id,
      parentId: input.parentId ?? null,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      position: input.position ?? null,
      idempotencyKey,
    });
  }

  async updateCategory(
    context: AuthorizationContext,
    categoryId: string,
    idempotencyKey: string,
    input: CategoryInput,
  ) {
    const proof = await this.authorize(context);
    return this.repository.updateCategory(proof, {
      tenantId: context.tenant.id,
      categoryId,
      parentId: input.parentId ?? null,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      position: input.position ?? null,
      idempotencyKey,
    });
  }

  async setCategoryStatus(
    context: AuthorizationContext,
    categoryId: string,
    idempotencyKey: string,
    input: { status: CategoryStatus; archiveReason?: string },
  ) {
    const proof = await this.authorize(context);
    return this.repository.setCategoryStatus(proof, {
      tenantId: context.tenant.id,
      categoryId,
      status: input.status,
      archiveReason: input.archiveReason ?? null,
      idempotencyKey,
    });
  }

  async setProductCategories(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
    categoryIds: readonly string[],
  ) {
    const proof = await this.authorize(context);
    return this.repository.setProductCategories(proof, {
      tenantId: context.tenant.id,
      productId,
      categoryIds: [...categoryIds],
      idempotencyKey,
    });
  }

  /** PUBLIC: published-only category tree for Storefront navigation. */
  async listStorefrontCategories(tenantId: string): Promise<PublicCategoryListResponse> {
    const rows = await this.repository.listStorefrontCategories(tenantId);
    return {
      categories: rows.map((raw) => {
        const row = DbPublicCategorySchema.parse(raw);
        return {
          id: row.id,
          parentId: row.parentId,
          slug: row.slug,
          name: row.name,
          description: row.description,
          position: row.position,
          productCount: row.productCount,
        };
      }),
    };
  }
}
