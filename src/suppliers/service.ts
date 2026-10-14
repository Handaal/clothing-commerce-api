import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import {
  CreateSupplierRequestSchema,
  UpdateSupplierRequestSchema,
  RecordSupplierPurchaseRequestSchema,
  RecordSupplierPaymentRequestSchema,
  CreateSupplierReminderRequestSchema,
  UpdateSupplierReminderRequestSchema,
  type CreateSupplierRequest,
  type UpdateSupplierRequest,
  type RecordSupplierPurchaseRequest,
  type RecordSupplierPaymentRequest,
  type CreateSupplierReminderRequest,
  type UpdateSupplierReminderRequest,
} from "../contracts/management/suppliers";
import { SupplierError } from "./errors";
import {
  SupplierListQuerySchema,
  SupplierPageQuerySchema,
  SupplierPurchaseListQuerySchema,
  SupplierReminderListQuerySchema,
  type SupplierListQuery,
  type SupplierPageQuery,
  type SupplierPurchaseListQuery,
  type SupplierReminderListQuery,
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
  async recordPurchase(
    context: AuthorizationContext,
    key: string,
    input: RecordSupplierPurchaseRequest,
  ) {
    const command = parse(RecordSupplierPurchaseRequestSchema, input);
    if (new Set(command.lines.map((line) => line.variantId)).size !== command.lines.length)
      throw new SupplierError("INVALID_SUPPLIER_PURCHASE");
    const total = command.lines.reduce((sum, line) => sum + line.quantity * line.unitCostMinor, 0);
    if (
      !Number.isSafeInteger(total) ||
      (command.paidMinor !== undefined && command.paidMinor > total)
    )
      throw new SupplierError("INVALID_SUPPLIER_PURCHASE");
    const proof = await this.authorize(context, SupplierPermission.manage);
    await this.authorization.authorize(context, {
      permissionKey: "inventory.receive",
      resources: [{ kind: "inventory_location", id: command.inventoryLocationId }],
    });
    return this.repository.recordPurchase(proof, key, command);
  }
  async purchases(context: AuthorizationContext, query: SupplierPurchaseListQuery) {
    return this.repository.purchases(
      await this.authorize(context, SupplierPermission.read),
      parse(SupplierPurchaseListQuerySchema, query),
    );
  }
  async purchaseItems(context: AuthorizationContext, purchaseId: string) {
    return this.repository.purchaseItems(
      await this.authorize(context, SupplierPermission.read),
      parse(z.uuid(), purchaseId),
    );
  }
  async recordPayment(
    context: AuthorizationContext,
    supplierId: string,
    key: string,
    input: RecordSupplierPaymentRequest,
  ) {
    return this.repository.recordPayment(
      await this.authorize(context, SupplierPermission.manage),
      parse(z.uuid(), supplierId),
      key,
      parse(RecordSupplierPaymentRequestSchema, input),
    );
  }
  async payments(context: AuthorizationContext, supplierId: string, query: SupplierPageQuery) {
    const proof = await this.authorize(context, SupplierPermission.read);
    await this.repository.detail(proof, parse(z.uuid(), supplierId));
    return this.repository.payments(proof, supplierId, parse(SupplierPageQuerySchema, query));
  }
  async dues(context: AuthorizationContext) {
    return this.repository.dues(await this.authorize(context, SupplierPermission.read));
  }
  async reminders(context: AuthorizationContext, query: SupplierReminderListQuery) {
    return this.repository.reminders(
      await this.authorize(context, SupplierPermission.read),
      parse(SupplierReminderListQuerySchema, query),
    );
  }
  async createReminder(
    context: AuthorizationContext,
    key: string,
    input: CreateSupplierReminderRequest,
  ) {
    return this.repository.writeReminder(
      await this.authorize(context, SupplierPermission.manage),
      null,
      key,
      parse(CreateSupplierReminderRequestSchema, input),
    );
  }
  async updateReminder(
    context: AuthorizationContext,
    reminderId: string,
    key: string,
    input: UpdateSupplierReminderRequest,
  ) {
    return this.repository.writeReminder(
      await this.authorize(context, SupplierPermission.manage),
      parse(z.uuid(), reminderId),
      key,
      parse(UpdateSupplierReminderRequestSchema, input),
    );
  }
  async deleteReminder(context: AuthorizationContext, reminderId: string, key: string) {
    return this.repository.deleteReminder(
      await this.authorize(context, SupplierPermission.manage),
      parse(z.uuid(), reminderId),
      key,
    );
  }
}
