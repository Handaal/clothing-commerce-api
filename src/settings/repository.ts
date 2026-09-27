import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  BusinessSettingsSchema,
  BrandSchema,
  BrandListResponseSchema,
  BranchSchema,
  BranchListResponseSchema,
  WarehouseSchema,
  WarehouseListResponseSchema,
  InventoryLocationSchema,
  InventoryLocationListResponseSchema,
  RegisterSchema,
  RegisterListResponseSchema,
  StorefrontSettingsSchema,
  StorefrontSettingsListResponseSchema,
  ReturnSettingsSchema,
  DeviceSchema,
  DeviceListResponseSchema,
} from "../contracts/management/settings";
import { InvalidCursorError } from "../management/cursor";
import { settingsDatabaseError } from "./errors";
import type {
  BrandListQuery,
  BranchListQuery,
  DeviceListQuery,
  InventoryLocationListQuery,
  RegisterListQuery,
  SettingsPageQuery,
  WarehouseListQuery,
} from "./request";

const CursorSchema = z.object({ v: z.literal(1), sort: z.string(), id: z.uuid() }).strict();

function cursorId(cursor: string | undefined, sort: string) {
  if (cursor === undefined) return null;
  try {
    const value = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (value.sort !== sort) throw new Error();
    return value.id;
  } catch {
    throw new InvalidCursorError();
  }
}

function pageInfo(ids: string[], limit: number, sort: string) {
  return {
    hasMore: ids.length > limit,
    nextCursor:
      ids.length > limit
        ? Buffer.from(JSON.stringify({ v: 1, sort, id: ids[limit - 1] })).toString("base64url")
        : null,
  };
}

export class SettingsRepository {
  constructor(private readonly client: SupabaseClient) {}

  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }
  private actor(proof: AuthorizedOperationContext) {
    return proof.authorization.membership.id;
  }
  private schema() {
    return this.client.schema("settings_private");
  }

  private async rpc<T>(
    fn: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const { data, error } = await this.schema().rpc(fn, args);
    if (error) throw settingsDatabaseError(error);
    return schema.parse(data);
  }

  private async paginate<Item extends { id: string }>(
    fn: string,
    args: Record<string, unknown>,
    query: SettingsPageQuery,
    sort: string,
    itemSchema: z.ZodType<Item>,
    responseSchema: z.ZodType<{ items: readonly Item[]; pageInfo: unknown }>,
  ) {
    const after = cursorId(query.cursor, sort);
    const rows = await this.rpc(
      fn,
      { ...args, p_after: after, p_limit: query.limit + 1 },
      z.array(itemSchema),
    );
    return responseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: pageInfo(
        rows.map((r) => r.id),
        query.limit,
        sort,
      ),
    });
  }

  // ---- Business (tenant) ----
  async getBusiness(proof: AuthorizedOperationContext) {
    return this.rpc("get_business", { p_tenant: this.tenant(proof) }, BusinessSettingsSchema);
  }
  async updateBusiness(proof: AuthorizedOperationContext, key: string, input: unknown) {
    return this.rpc(
      "write_business",
      { p_tenant: this.tenant(proof), p_actor: this.actor(proof), p_key: key, p_input: input },
      BusinessSettingsSchema,
    );
  }

  // ---- Brands ----
  async listBrands(proof: AuthorizedOperationContext, query: BrandListQuery) {
    return this.paginate(
      "list_brands",
      { p_tenant: this.tenant(proof), p_status: query.status ?? null },
      query,
      "settings_brands_id_asc",
      BrandSchema,
      BrandListResponseSchema,
    );
  }
  async getBrand(proof: AuthorizedOperationContext, id: string) {
    return this.rpc("get_brand", { p_tenant: this.tenant(proof), p_brand: id }, BrandSchema);
  }
  async writeBrand(
    proof: AuthorizedOperationContext,
    id: string | null,
    key: string,
    input: unknown,
  ) {
    return this.rpc(
      "write_brand",
      {
        p_tenant: this.tenant(proof),
        p_brand: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_input: input,
      },
      BrandSchema,
    );
  }

  // ---- Branches ----
  async listBranches(proof: AuthorizedOperationContext, query: BranchListQuery) {
    return this.paginate(
      "list_branches",
      { p_tenant: this.tenant(proof), p_status: query.status ?? null },
      query,
      "settings_branches_id_asc",
      BranchSchema,
      BranchListResponseSchema,
    );
  }
  async getBranch(proof: AuthorizedOperationContext, id: string) {
    return this.rpc("get_branch", { p_tenant: this.tenant(proof), p_branch: id }, BranchSchema);
  }
  async writeBranch(
    proof: AuthorizedOperationContext,
    id: string | null,
    key: string,
    input: unknown,
  ) {
    return this.rpc(
      "write_branch",
      {
        p_tenant: this.tenant(proof),
        p_branch: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_input: input,
      },
      BranchSchema,
    );
  }
  async setBranchBrands(
    proof: AuthorizedOperationContext,
    id: string,
    key: string,
    brandIds: string[],
  ) {
    return this.rpc(
      "set_branch_brands",
      {
        p_tenant: this.tenant(proof),
        p_branch: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_brand_ids: brandIds,
      },
      BranchSchema,
    );
  }

  // ---- Warehouses ----
  async listWarehouses(proof: AuthorizedOperationContext, query: WarehouseListQuery) {
    return this.paginate(
      "list_warehouses",
      { p_tenant: this.tenant(proof), p_status: query.status ?? null },
      query,
      "settings_warehouses_id_asc",
      WarehouseSchema,
      WarehouseListResponseSchema,
    );
  }
  async getWarehouse(proof: AuthorizedOperationContext, id: string) {
    return this.rpc(
      "get_warehouse",
      { p_tenant: this.tenant(proof), p_warehouse: id },
      WarehouseSchema,
    );
  }
  async writeWarehouse(
    proof: AuthorizedOperationContext,
    id: string | null,
    key: string,
    input: unknown,
  ) {
    return this.rpc(
      "write_warehouse",
      {
        p_tenant: this.tenant(proof),
        p_warehouse: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_input: input,
      },
      WarehouseSchema,
    );
  }

  // ---- Inventory locations ----
  async listInventoryLocations(
    proof: AuthorizedOperationContext,
    query: InventoryLocationListQuery,
  ) {
    return this.paginate(
      "list_inventory_locations",
      {
        p_tenant: this.tenant(proof),
        p_branch: query.branchId ?? null,
        p_warehouse: query.warehouseId ?? null,
        p_status: query.status ?? null,
      },
      query,
      "settings_locations_id_asc",
      InventoryLocationSchema,
      InventoryLocationListResponseSchema,
    );
  }
  async getInventoryLocation(proof: AuthorizedOperationContext, id: string) {
    return this.rpc(
      "get_inventory_location",
      { p_tenant: this.tenant(proof), p_location: id },
      InventoryLocationSchema,
    );
  }
  async writeInventoryLocation(
    proof: AuthorizedOperationContext,
    id: string | null,
    key: string,
    input: unknown,
  ) {
    return this.rpc(
      "write_inventory_location",
      {
        p_tenant: this.tenant(proof),
        p_location: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_input: input,
      },
      InventoryLocationSchema,
    );
  }

  // ---- Registers ----
  async listRegisters(proof: AuthorizedOperationContext, query: RegisterListQuery) {
    return this.paginate(
      "list_registers",
      {
        p_tenant: this.tenant(proof),
        p_branch: query.branchId ?? null,
        p_status: query.status ?? null,
      },
      query,
      "settings_registers_id_asc",
      RegisterSchema,
      RegisterListResponseSchema,
    );
  }
  async getRegister(proof: AuthorizedOperationContext, id: string) {
    return this.rpc(
      "get_register",
      { p_tenant: this.tenant(proof), p_register: id },
      RegisterSchema,
    );
  }
  async writeRegister(
    proof: AuthorizedOperationContext,
    id: string | null,
    key: string,
    input: unknown,
  ) {
    return this.rpc(
      "write_register",
      {
        p_tenant: this.tenant(proof),
        p_register: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_input: input,
      },
      RegisterSchema,
    );
  }

  // ---- Storefront ----
  async listStorefront(proof: AuthorizedOperationContext) {
    const items = await this.rpc(
      "list_storefront",
      { p_tenant: this.tenant(proof) },
      z.array(StorefrontSettingsSchema),
    );
    return StorefrontSettingsListResponseSchema.parse({ items });
  }
  async getStorefront(proof: AuthorizedOperationContext, brandId: string) {
    return this.rpc(
      "get_storefront",
      { p_tenant: this.tenant(proof), p_brand: brandId },
      StorefrontSettingsSchema,
    );
  }
  async upsertStorefront(
    proof: AuthorizedOperationContext,
    brandId: string,
    key: string,
    input: unknown,
  ) {
    return this.rpc(
      "write_storefront",
      {
        p_tenant: this.tenant(proof),
        p_brand: brandId,
        p_actor: this.actor(proof),
        p_key: key,
        p_input: input,
      },
      StorefrontSettingsSchema,
    );
  }

  // ---- Returns ----
  async getReturnSettings(proof: AuthorizedOperationContext) {
    return this.rpc("get_return_settings", { p_tenant: this.tenant(proof) }, ReturnSettingsSchema);
  }
  async updateReturnSettings(proof: AuthorizedOperationContext, key: string, input: unknown) {
    return this.rpc(
      "write_return_settings",
      { p_tenant: this.tenant(proof), p_actor: this.actor(proof), p_key: key, p_input: input },
      ReturnSettingsSchema,
    );
  }

  // ---- Devices ----
  async listDevices(proof: AuthorizedOperationContext, query: DeviceListQuery) {
    return this.paginate(
      "list_devices",
      { p_tenant: this.tenant(proof), p_status: query.status ?? null },
      query,
      "settings_devices_id_asc",
      DeviceSchema,
      DeviceListResponseSchema,
    );
  }
  async getDevice(proof: AuthorizedOperationContext, id: string) {
    return this.rpc("get_device", { p_tenant: this.tenant(proof), p_device: id }, DeviceSchema);
  }
  async revokeDevice(
    proof: AuthorizedOperationContext,
    id: string,
    key: string,
    reason: string | null,
  ) {
    return this.rpc(
      "revoke_device",
      {
        p_tenant: this.tenant(proof),
        p_device: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_reason: reason,
      },
      DeviceSchema,
    );
  }
  async assignDevice(
    proof: AuthorizedOperationContext,
    id: string,
    registerId: string,
    key: string,
    reason: string | null,
  ) {
    return this.rpc(
      "assign_device",
      {
        p_tenant: this.tenant(proof),
        p_register: registerId,
        p_device: id,
        p_actor: this.actor(proof),
        p_key: key,
        p_reason: reason,
      },
      DeviceSchema,
    );
  }
}

export function createSettingsRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new SettingsRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
