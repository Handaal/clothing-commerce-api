import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type {
  IdSelector,
  OrgBrand,
  OrgBranch,
  OrgInventoryLocation,
  OrgInventoryLocationCapability,
  OrganizationReadRepository,
  OrgTenantSummary,
} from "./organization-read-repository";

const TenantRowSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
});

const NamedRowSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
});

const LocationRowSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  branch_id: z.string().uuid().nullable(),
});

const LocationCapabilityRowSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  status: z.enum(["active", "inactive", "archived"]),
  is_receiving_enabled: z.boolean(),
  is_transfer_origin_enabled: z.boolean(),
  is_transfer_destination_enabled: z.boolean(),
});

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error("Organization metadata row failed validation.");
  }
  return parsed.data;
}

function requireNoQueryError(error: unknown): void {
  if (error) {
    throw new Error("An unexpected organization metadata query error occurred.");
  }
}

/**
 * Server-only adapter around a service-role client. It exposes only tenant-filtered read metadata; there
 * is no generic query escape hatch and no write method. Hydration queries always constrain by tenant_id
 * and, for explicit grants, by the exact id set the visibility derivation produced.
 */
export class SupabaseOrganizationReadRepository implements OrganizationReadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findTenantSummary(tenantId: string): Promise<OrgTenantSummary | null> {
    const { data, error } = await this.client
      .from("tenants")
      .select("id,display_name,status")
      .eq("id", tenantId)
      .limit(2);
    requireNoQueryError(error);
    const rows = parseRows(TenantRowSchema, data);
    if (rows.length !== 1) {
      return null;
    }
    const row = rows[0];
    return { id: row.id, name: row.display_name, status: row.status };
  }

  async findBrands(tenantId: string, selector: IdSelector): Promise<OrgBrand[]> {
    if (selector !== null && selector.length === 0) {
      return [];
    }
    let query = this.client.from("brands").select("id,display_name").eq("tenant_id", tenantId);
    if (selector !== null) {
      query = query.in("id", [...selector]);
    }
    const { data, error } = await query;
    requireNoQueryError(error);
    return parseRows(NamedRowSchema, data).map((row) => ({ id: row.id, name: row.display_name }));
  }

  async findBranches(tenantId: string, selector: IdSelector): Promise<OrgBranch[]> {
    if (selector !== null && selector.length === 0) {
      return [];
    }
    let query = this.client.from("branches").select("id,display_name").eq("tenant_id", tenantId);
    if (selector !== null) {
      query = query.in("id", [...selector]);
    }
    const { data, error } = await query;
    requireNoQueryError(error);
    return parseRows(NamedRowSchema, data).map((row) => ({ id: row.id, name: row.display_name }));
  }

  async findInventoryLocations(
    tenantId: string,
    selector: IdSelector,
  ): Promise<OrgInventoryLocation[]> {
    if (selector !== null && selector.length === 0) {
      return [];
    }
    let query = this.client
      .from("inventory_locations")
      .select("id,display_name,branch_id")
      .eq("tenant_id", tenantId);
    if (selector !== null) {
      query = query.in("id", [...selector]);
    }
    const { data, error } = await query;
    requireNoQueryError(error);
    return parseRows(LocationRowSchema, data).map((row) => ({
      id: row.id,
      name: row.display_name,
      branchId: row.branch_id,
    }));
  }

  async findInventoryLocationCapabilities(
    tenantId: string,
    selector: IdSelector,
  ): Promise<OrgInventoryLocationCapability[]> {
    if (selector !== null && selector.length === 0) {
      return [];
    }
    let query = this.client
      .from("inventory_locations")
      .select(
        "id,display_name,status,is_receiving_enabled,is_transfer_origin_enabled,is_transfer_destination_enabled",
      )
      .eq("tenant_id", tenantId);
    if (selector !== null) {
      query = query.in("id", [...selector]);
    }
    const { data, error } = await query;
    requireNoQueryError(error);
    return parseRows(LocationCapabilityRowSchema, data).map((row) => ({
      id: row.id,
      name: row.display_name,
      status: row.status,
      isReceivingEnabled: row.is_receiving_enabled,
      isTransferOriginEnabled: row.is_transfer_origin_enabled,
      isTransferDestinationEnabled: row.is_transfer_destination_enabled,
    }));
  }
}

export interface SupabaseOrganizationReadRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseOrganizationReadRepository(
  configuration: SupabaseOrganizationReadRepositoryConfiguration,
): SupabaseOrganizationReadRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseOrganizationReadRepository(client);
}
