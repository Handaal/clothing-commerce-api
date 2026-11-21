import { z } from "zod";

import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import type { VendorListResponse, VendorStatus } from "../contracts/management/vendors";
import type { PublicVendorListResponse } from "../contracts/storefront/catalog";
import { IntegerLikeSchema } from "./public-product-shape";
import type { VendorRepository } from "./vendor-repository";
import { authorizeCatalogLabelRead } from "./label-read-authorization";

/**
 * Vendors (the labels a retailer sells, shown as "Brand") are tenant-wide like categories, so
 * management authorizes catalog.author tenant-wide. Idempotency, slug conflicts and membership
 * integrity live in the sanctioned DB functions.
 */
export const VendorPermission = { author: "catalog.author" } as const;

export interface VendorInput {
  name: string;
  slug: string;
  position?: number;
}

const DbPublicVendorSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  position: IntegerLikeSchema,
  productCount: IntegerLikeSchema,
});

export class VendorService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: VendorRepository,
  ) {}

  private authorize(context: AuthorizationContext) {
    return this.authorization.authorize(context, { permissionKey: VendorPermission.author });
  }

  async listVendors(context: AuthorizationContext): Promise<VendorListResponse> {
    const proof = await authorizeCatalogLabelRead(
      this.authorization,
      context,
      VendorPermission.author,
    );
    return { vendors: await this.repository.listVendors(proof, context.tenant.id) };
  }

  async createVendor(context: AuthorizationContext, idempotencyKey: string, input: VendorInput) {
    const proof = await this.authorize(context);
    return this.repository.createVendor(proof, {
      tenantId: context.tenant.id,
      name: input.name,
      slug: input.slug,
      position: input.position ?? null,
      idempotencyKey,
    });
  }

  async updateVendor(
    context: AuthorizationContext,
    vendorId: string,
    idempotencyKey: string,
    input: VendorInput,
  ) {
    const proof = await this.authorize(context);
    return this.repository.updateVendor(proof, {
      tenantId: context.tenant.id,
      vendorId,
      name: input.name,
      slug: input.slug,
      position: input.position ?? null,
      idempotencyKey,
    });
  }

  async setVendorStatus(
    context: AuthorizationContext,
    vendorId: string,
    idempotencyKey: string,
    status: VendorStatus,
  ) {
    const proof = await this.authorize(context);
    return this.repository.setVendorStatus(proof, {
      tenantId: context.tenant.id,
      vendorId,
      status,
      idempotencyKey,
    });
  }

  async setProductVendor(
    context: AuthorizationContext,
    productId: string,
    idempotencyKey: string,
    vendorId: string | null,
  ) {
    const proof = await this.authorize(context);
    return this.repository.setProductVendor(proof, {
      tenantId: context.tenant.id,
      productId,
      vendorId,
      idempotencyKey,
    });
  }

  /** PUBLIC: vendors with publicly visible products, for "shop by brand". */
  async listStorefrontVendors(tenantId: string): Promise<PublicVendorListResponse> {
    const rows = await this.repository.listStorefrontVendors(tenantId);
    return {
      vendors: rows.map((raw) => {
        const row = DbPublicVendorSchema.parse(raw);
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          position: row.position,
          productCount: row.productCount,
        };
      }),
    };
  }
}
