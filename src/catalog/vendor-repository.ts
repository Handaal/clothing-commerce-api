import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import type { VendorStatus, VendorSummary } from "../contracts/management/vendors";
import { CatalogError } from "./catalog-errors";

const CATALOG_PRIVATE_SCHEMA = "catalog_private";
const CATALOG_PUBLIC_SCHEMA = "catalog_public";

export interface CreateVendorCommand {
  tenantId: string;
  name: string;
  slug: string;
  position: number | null;
  idempotencyKey: string;
}
export interface UpdateVendorCommand extends CreateVendorCommand {
  vendorId: string;
}
export interface SetVendorStatusCommand {
  tenantId: string;
  vendorId: string;
  status: VendorStatus;
  idempotencyKey: string;
}
export interface SetProductVendorCommand {
  tenantId: string;
  productId: string;
  vendorId: string | null;
  idempotencyKey: string;
}

export interface VendorRepository {
  listVendors(proof: AuthorizedOperationContext, tenantId: string): Promise<VendorSummary[]>;
  createVendor(
    proof: AuthorizedOperationContext,
    command: CreateVendorCommand,
  ): Promise<{ vendorId: string; status: VendorStatus }>;
  updateVendor(
    proof: AuthorizedOperationContext,
    command: UpdateVendorCommand,
  ): Promise<{ vendorId: string }>;
  setVendorStatus(
    proof: AuthorizedOperationContext,
    command: SetVendorStatusCommand,
  ): Promise<{ vendorId: string; status: VendorStatus }>;
  setProductVendor(
    proof: AuthorizedOperationContext,
    command: SetProductVendorCommand,
  ): Promise<{ productId: string; vendorId: string | null }>;
  /** Public, published-only vendor list (DB-enforced projection). */
  listStorefrontVendors(tenantId: string): Promise<unknown[]>;
}

function mapDatabaseError(error: { readonly code?: string }): Error {
  switch (error.code) {
    case "CT001":
      return new CatalogError("PRODUCT_NOT_FOUND");
    case "CT060":
      return new CatalogError("VENDOR_NOT_FOUND");
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
      return new Error("An unexpected vendor persistence error occurred.");
  }
}

const StatusSchema = z.enum(["active", "archived"]);
const VendorRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  position: z.number().int(),
  status: StatusSchema,
  products: z.array(z.object({ count: z.number() })).optional(),
});
const WriteRowSchema = z.object({ vendor_id: z.string().uuid(), status: StatusSchema });
const UpdateRowSchema = z.object({ vendor_id: z.string().uuid() });
const ProductVendorRowSchema = z.object({
  product_id: z.string().uuid(),
  vendor_id: z.string().uuid().nullable(),
});

/**
 * Server-only adapter around a service-role client: reads select directly, writes call the sanctioned
 * catalog_private functions, and the public list goes through catalog_public. Every management method
 * asserts the authorization proof before privileged access.
 */
export class SupabaseVendorRepository implements VendorRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listVendors(proof: AuthorizedOperationContext, tenantId: string): Promise<VendorSummary[]> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("vendors")
      .select("id, name, slug, position, status, products(count)")
      .eq("tenant_id", tenantId)
      .order("position", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      throw mapDatabaseError(error);
    }
    return (data ?? []).map((raw) => {
      const row = VendorRowSchema.parse(raw);
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        position: row.position,
        status: row.status,
        productCount: row.products?.[0]?.count ?? 0,
      };
    });
  }

  async createVendor(proof: AuthorizedOperationContext, command: CreateVendorCommand) {
    assertAuthorizedOperationProof(proof);
    const row = WriteRowSchema.parse(
      await this.callFunction("create_vendor", {
        p_tenant_id: command.tenantId,
        p_name: command.name,
        p_slug: command.slug,
        p_position: command.position,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { vendorId: row.vendor_id, status: row.status };
  }

  async updateVendor(proof: AuthorizedOperationContext, command: UpdateVendorCommand) {
    assertAuthorizedOperationProof(proof);
    const row = UpdateRowSchema.parse(
      await this.callFunction("update_vendor", {
        p_tenant_id: command.tenantId,
        p_vendor_id: command.vendorId,
        p_name: command.name,
        p_slug: command.slug,
        p_position: command.position,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { vendorId: row.vendor_id };
  }

  async setVendorStatus(proof: AuthorizedOperationContext, command: SetVendorStatusCommand) {
    assertAuthorizedOperationProof(proof);
    const row = WriteRowSchema.parse(
      await this.callFunction("set_vendor_status", {
        p_tenant_id: command.tenantId,
        p_vendor_id: command.vendorId,
        p_target_status: command.status,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { vendorId: row.vendor_id, status: row.status };
  }

  async setProductVendor(proof: AuthorizedOperationContext, command: SetProductVendorCommand) {
    assertAuthorizedOperationProof(proof);
    const row = ProductVendorRowSchema.parse(
      await this.callFunction("set_product_vendor", {
        p_tenant_id: command.tenantId,
        p_product_id: command.productId,
        p_vendor_id: command.vendorId,
        p_idempotency_key: command.idempotencyKey,
      }),
    );
    return { productId: row.product_id, vendorId: row.vendor_id };
  }

  async listStorefrontVendors(tenantId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .schema(CATALOG_PUBLIC_SCHEMA)
      .rpc("list_storefront_vendors", { p_tenant_id: tenantId });
    if (error) {
      throw new Error("An unexpected public vendor read error occurred.");
    }
    const rows = (Array.isArray(data) ? data : []) as ReadonlyArray<{ vendor?: unknown }>;
    return rows.map((row) => row.vendor);
  }

  private async callFunction(name: string, params: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.schema(CATALOG_PRIVATE_SCHEMA).rpc(name, params);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0 || rows[0] === null || rows[0] === undefined) {
      throw new Error(`Vendor function ${name} returned no result row.`);
    }
    return rows[0];
  }
}

export function createSupabaseVendorRepository(configuration: {
  readonly url: string;
  readonly serviceRoleKey: string;
}): SupabaseVendorRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseVendorRepository(client);
}
