import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import {
  UpdateBusinessRequestSchema,
  CreateBrandRequestSchema,
  UpdateBrandRequestSchema,
  CreateBranchRequestSchema,
  UpdateBranchRequestSchema,
  SetBranchBrandsRequestSchema,
  CreateWarehouseRequestSchema,
  UpdateWarehouseRequestSchema,
  CreateInventoryLocationRequestSchema,
  UpdateInventoryLocationRequestSchema,
  CreateRegisterRequestSchema,
  UpdateRegisterRequestSchema,
  UpsertStorefrontSettingsRequestSchema,
  UpdateReturnSettingsRequestSchema,
  RevokeDeviceRequestSchema,
  AssignDeviceRequestSchema,
} from "../contracts/management/settings";
import { SettingsError } from "./errors";
import {
  BrandListQuerySchema,
  BranchListQuerySchema,
  DeviceListQuerySchema,
  InventoryLocationListQuerySchema,
  RegisterListQuerySchema,
  WarehouseListQuerySchema,
  type BrandListQuery,
  type BranchListQuery,
  type DeviceListQuery,
  type InventoryLocationListQuery,
  type RegisterListQuery,
  type WarehouseListQuery,
} from "./request";
import type { SettingsRepository } from "./repository";

export const SettingsPermission = { read: "settings.read", manage: "settings.manage" } as const;

/**
 * UI guidance for /me/context. settings.read and settings.manage are independent tenant-wide
 * capabilities; neither implies the other, and a scoped brand/branch grant never confers either.
 */
export function settingsCapabilities(context: AuthorizationContext) {
  const has = (key: string) =>
    context.assignments.some((a) => a.scopeMode === "tenant" && a.permissionKeys.includes(key));
  return { canRead: has(SettingsPermission.read), canManage: has(SettingsPermission.manage) };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SettingsError("INVALID_SETTINGS");
  return result.data;
}

/**
 * Operational-settings management service. Every read authorizes tenant-wide settings.read and every
 * mutation authorizes tenant-wide settings.manage; there is no resource target, so the shared authorizer
 * requires a permission-coupled tenant-wide grant. Mutation-safety rules live in the database RPCs.
 */
export class SettingsService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: SettingsRepository,
  ) {}

  private read(context: AuthorizationContext) {
    return this.authorization.authorize(context, { permissionKey: SettingsPermission.read });
  }
  private manage(context: AuthorizationContext) {
    return this.authorization.authorize(context, { permissionKey: SettingsPermission.manage });
  }

  // ---- Business ----
  async getBusiness(context: AuthorizationContext) {
    return this.repository.getBusiness(await this.read(context));
  }
  async updateBusiness(context: AuthorizationContext, key: string, input: unknown) {
    return this.repository.updateBusiness(
      await this.manage(context),
      key,
      parse(UpdateBusinessRequestSchema, input),
    );
  }

  // ---- Brands ----
  async listBrands(context: AuthorizationContext, query: BrandListQuery) {
    return this.repository.listBrands(await this.read(context), parse(BrandListQuerySchema, query));
  }
  async getBrand(context: AuthorizationContext, id: string) {
    return this.repository.getBrand(await this.read(context), parse(z.uuid(), id));
  }
  async createBrand(context: AuthorizationContext, key: string, input: unknown) {
    return this.repository.writeBrand(
      await this.manage(context),
      null,
      key,
      parse(CreateBrandRequestSchema, input),
    );
  }
  async updateBrand(context: AuthorizationContext, id: string, key: string, input: unknown) {
    return this.repository.writeBrand(
      await this.manage(context),
      parse(z.uuid(), id),
      key,
      parse(UpdateBrandRequestSchema, input),
    );
  }

  // ---- Branches ----
  async listBranches(context: AuthorizationContext, query: BranchListQuery) {
    return this.repository.listBranches(
      await this.read(context),
      parse(BranchListQuerySchema, query),
    );
  }
  async getBranch(context: AuthorizationContext, id: string) {
    return this.repository.getBranch(await this.read(context), parse(z.uuid(), id));
  }
  async createBranch(context: AuthorizationContext, key: string, input: unknown) {
    return this.repository.writeBranch(
      await this.manage(context),
      null,
      key,
      parse(CreateBranchRequestSchema, input),
    );
  }
  async updateBranch(context: AuthorizationContext, id: string, key: string, input: unknown) {
    return this.repository.writeBranch(
      await this.manage(context),
      parse(z.uuid(), id),
      key,
      parse(UpdateBranchRequestSchema, input),
    );
  }
  async setBranchBrands(context: AuthorizationContext, id: string, key: string, input: unknown) {
    const body = parse(SetBranchBrandsRequestSchema, input);
    return this.repository.setBranchBrands(
      await this.manage(context),
      parse(z.uuid(), id),
      key,
      body.brandIds,
    );
  }

  // ---- Warehouses ----
  async listWarehouses(context: AuthorizationContext, query: WarehouseListQuery) {
    return this.repository.listWarehouses(
      await this.read(context),
      parse(WarehouseListQuerySchema, query),
    );
  }
  async getWarehouse(context: AuthorizationContext, id: string) {
    return this.repository.getWarehouse(await this.read(context), parse(z.uuid(), id));
  }
  async createWarehouse(context: AuthorizationContext, key: string, input: unknown) {
    return this.repository.writeWarehouse(
      await this.manage(context),
      null,
      key,
      parse(CreateWarehouseRequestSchema, input),
    );
  }
  async updateWarehouse(context: AuthorizationContext, id: string, key: string, input: unknown) {
    return this.repository.writeWarehouse(
      await this.manage(context),
      parse(z.uuid(), id),
      key,
      parse(UpdateWarehouseRequestSchema, input),
    );
  }

  // ---- Inventory locations ----
  async listInventoryLocations(context: AuthorizationContext, query: InventoryLocationListQuery) {
    return this.repository.listInventoryLocations(
      await this.read(context),
      parse(InventoryLocationListQuerySchema, query),
    );
  }
  async getInventoryLocation(context: AuthorizationContext, id: string) {
    return this.repository.getInventoryLocation(await this.read(context), parse(z.uuid(), id));
  }
  async createInventoryLocation(context: AuthorizationContext, key: string, input: unknown) {
    return this.repository.writeInventoryLocation(
      await this.manage(context),
      null,
      key,
      parse(CreateInventoryLocationRequestSchema, input),
    );
  }
  async updateInventoryLocation(
    context: AuthorizationContext,
    id: string,
    key: string,
    input: unknown,
  ) {
    return this.repository.writeInventoryLocation(
      await this.manage(context),
      parse(z.uuid(), id),
      key,
      parse(UpdateInventoryLocationRequestSchema, input),
    );
  }

  // ---- Registers ----
  async listRegisters(context: AuthorizationContext, query: RegisterListQuery) {
    return this.repository.listRegisters(
      await this.read(context),
      parse(RegisterListQuerySchema, query),
    );
  }
  async getRegister(context: AuthorizationContext, id: string) {
    return this.repository.getRegister(await this.read(context), parse(z.uuid(), id));
  }
  async createRegister(context: AuthorizationContext, key: string, input: unknown) {
    return this.repository.writeRegister(
      await this.manage(context),
      null,
      key,
      parse(CreateRegisterRequestSchema, input),
    );
  }
  async updateRegister(context: AuthorizationContext, id: string, key: string, input: unknown) {
    return this.repository.writeRegister(
      await this.manage(context),
      parse(z.uuid(), id),
      key,
      parse(UpdateRegisterRequestSchema, input),
    );
  }

  // ---- Storefront ----
  async listStorefront(context: AuthorizationContext) {
    return this.repository.listStorefront(await this.read(context));
  }
  async getStorefront(context: AuthorizationContext, brandId: string) {
    return this.repository.getStorefront(await this.read(context), parse(z.uuid(), brandId));
  }
  async upsertStorefront(
    context: AuthorizationContext,
    brandId: string,
    key: string,
    input: unknown,
  ) {
    return this.repository.upsertStorefront(
      await this.manage(context),
      parse(z.uuid(), brandId),
      key,
      parse(UpsertStorefrontSettingsRequestSchema, input),
    );
  }

  // ---- Returns ----
  async getReturnSettings(context: AuthorizationContext) {
    return this.repository.getReturnSettings(await this.read(context));
  }
  async updateReturnSettings(context: AuthorizationContext, key: string, input: unknown) {
    return this.repository.updateReturnSettings(
      await this.manage(context),
      key,
      parse(UpdateReturnSettingsRequestSchema, input),
    );
  }

  // ---- Devices ----
  async listDevices(context: AuthorizationContext, query: DeviceListQuery) {
    return this.repository.listDevices(
      await this.read(context),
      parse(DeviceListQuerySchema, query),
    );
  }
  async getDevice(context: AuthorizationContext, id: string) {
    return this.repository.getDevice(await this.read(context), parse(z.uuid(), id));
  }
  async revokeDevice(context: AuthorizationContext, id: string, key: string, input: unknown) {
    const body = parse(RevokeDeviceRequestSchema, input);
    return this.repository.revokeDevice(
      await this.manage(context),
      parse(z.uuid(), id),
      key,
      body.reason ?? null,
    );
  }
  async assignDevice(context: AuthorizationContext, id: string, key: string, input: unknown) {
    const body = parse(AssignDeviceRequestSchema, input);
    return this.repository.assignDevice(
      await this.manage(context),
      parse(z.uuid(), id),
      body.registerId,
      key,
      body.reason ?? null,
    );
  }
}
