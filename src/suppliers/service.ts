import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import {
  CreateSupplierRequestSchema,
  UpdateSupplierRequestSchema,
  type CreateSupplierRequest,
  type UpdateSupplierRequest,
} from "../contracts/management/suppliers";
import { SupplierError } from "./errors";
import {
  SupplierListQuerySchema,
  SupplierPageQuerySchema,
  type SupplierListQuery,
  type SupplierPageQuery,
} from "./request";
import type { SuppliersRepository } from "./repository";

export const SupplierPermission = { read: "suppliers.read", manage: "suppliers.manage" } as const;
export function supplierCapabilities(context: AuthorizationContext) {
  const has = (key: string) =>
    context.assignments.some((a) => a.scopeMode === "tenant" && a.permissionKeys.includes(key));
  return { canRead: has(SupplierPermission.read), canManage: has(SupplierPermission.manage) };
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SupplierError("INVALID_SUPPLIER");
  return result.data;
}
export class SuppliersService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: SuppliersRepository,
  ) {}
  private authorize(context: AuthorizationContext, permissionKey: string) {
    // No resource target: the shared authorizer requires a permission-coupled tenant-wide grant.
    return this.authorization.authorize(context, { permissionKey });
  }
  async list(context: AuthorizationContext, query: SupplierListQuery) {
    return this.repository.list(
      await this.authorize(context, SupplierPermission.read),
      parse(SupplierListQuerySchema, query),
    );
  }
  async detail(context: AuthorizationContext, id: string) {
    return this.repository.detail(
      await this.authorize(context, SupplierPermission.read),
      parse(z.uuid(), id),
    );
  }
  async create(context: AuthorizationContext, key: string, input: CreateSupplierRequest) {
    return this.repository.write(
      await this.authorize(context, SupplierPermission.manage),
      null,
      key,
      parse(CreateSupplierRequestSchema, input),
    );
  }
  async update(
    context: AuthorizationContext,
    id: string,
    key: string,
    input: UpdateSupplierRequest,
  ) {
    return this.repository.write(
      await this.authorize(context, SupplierPermission.manage),
      parse(z.uuid(), id),
      key,
      parse(UpdateSupplierRequestSchema, input),
    );
  }
  async receipts(context: AuthorizationContext, id: string, query: SupplierPageQuery) {
    const proof = await this.authorize(context, SupplierPermission.read);
    // Supplier ownership is tenant-wide, but inventory history is filtered to inventory.read scope.
    await this.repository.detail(proof, parse(z.uuid(), id));
    return this.repository.receipts(proof, id, parse(SupplierPageQuerySchema, query));
  }
}
