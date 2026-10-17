import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  assertAuthorizedOperationProof,
  type AuthorizedOperationContext,
  AuthorizationError,
} from "../authorization";
import {
  SupplierSchema,
  SupplierListResponseSchema,
  SupplierReceiptSchema,
  SupplierReceiptsResponseSchema,
  SupplierPurchaseSchema,
  SupplierPurchasesResponseSchema,
  SupplierPurchaseItemSchema,
  SupplierPurchaseItemsResponseSchema,
  SupplierPaymentSchema,
  SupplierPaymentsResponseSchema,
  SupplierDuesResponseSchema,
  SupplierReminderSchema,
  SupplierRemindersResponseSchema,
  DeleteSupplierReminderResponseSchema,
  type CreateSupplierRequest,
  type UpdateSupplierRequest,
  type RecordSupplierPurchaseRequest,
  type RecordSupplierPaymentRequest,
  type CreateSupplierReminderRequest,
  type UpdateSupplierReminderRequest,
} from "../contracts/management/suppliers";
import { InvalidCursorError } from "../management/cursor";
import { deriveInventoryReadVisibility } from "../management/visibility";
import { SupplierError, supplierDatabaseError } from "./errors";
import type {
  SupplierListQuery,
  SupplierPageQuery,
  SupplierPurchaseListQuery,
  SupplierReminderListQuery,
} from "./request";

const CursorSchema = z
  .object({
    v: z.literal(1),
    sort: z.enum([
      "suppliers_id_asc",
      "supplier_receipts_id_asc",
      "supplier_purchases_id_desc",
      "supplier_payments_id_desc",
    ]),
    id: z.uuid(),
  })
  .strict();
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
const selection =
  "id,tenantId:tenant_id,name,code,status,contactPerson:contact_person,phone,email,address,notes,createdAt:created_at,updatedAt:updated_at";
export class SuppliersRepository {
  constructor(private readonly client: SupabaseClient) {}
  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }
  async detail(proof: AuthorizedOperationContext, id: string) {
    const { data, error } = await this.client
      .from("suppliers")
      .select(selection)
      .eq("tenant_id", this.tenant(proof))
      .eq("id", id)
      .maybeSingle();
    if (error) throw supplierDatabaseError(error);
    if (!data) throw new SupplierError("SUPPLIER_NOT_FOUND");
    return SupplierSchema.parse(data);
  }
  async list(proof: AuthorizedOperationContext, query: SupplierListQuery) {
    const sort = "suppliers_id_asc";
    const after = cursorId(query.cursor, sort);
    // Search uses SQL position(), not interpolated PostgREST filters or LIKE wildcards.
    const { data, error } = await this.client.schema("suppliers_private").rpc("list_suppliers", {
      p_tenant: this.tenant(proof),
      p_search: query.search ?? null,
      p_status: query.status ?? null,
      p_after: after,
      p_limit: query.limit + 1,
    });
    if (error) throw supplierDatabaseError(error);
    const rows = z.array(SupplierSchema).parse(data);
    return SupplierListResponseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: pageInfo(
        rows.map((r) => r.id),
        query.limit,
        sort,
      ),
    });
  }
  async write(
    proof: AuthorizedOperationContext,
    id: string | null,
    key: string,
    input: CreateSupplierRequest | UpdateSupplierRequest,
  ) {
    const { data, error } = await this.client.schema("suppliers_private").rpc("write_supplier", {
      p_tenant: this.tenant(proof),
      p_supplier: id,
      p_actor: proof.authorization.membership.id,
      p_key: key,
      p_input: input,
    });
    if (error) throw supplierDatabaseError(error);
    return SupplierSchema.parse(data);
  }
  async receipts(proof: AuthorizedOperationContext, id: string, query: SupplierPageQuery) {
    const tenant = this.tenant(proof);
    const visibility = deriveInventoryReadVisibility(proof.authorization);
    if (!visibility.canRead) throw new AuthorizationError("PERMISSION_DENIED");
    const sort = "supplier_receipts_id_asc";
    const { data, error } = await this.client.schema("suppliers_private").rpc("supplier_receipts", {
      p_tenant: tenant,
      p_supplier: id,
      p_locations: visibility.tenantWide ? null : visibility.locationIds,
      p_after: cursorId(query.cursor, sort),
      p_limit: query.limit + 1,
    });
    if (error) throw supplierDatabaseError(error);
    const rows = z.array(SupplierReceiptSchema).parse(data);
    return SupplierReceiptsResponseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: pageInfo(
        rows.map((r) => r.operationId),
        query.limit,
        sort,
      ),
    });
  }
  async recordPurchase(
    proof: AuthorizedOperationContext,
    key: string,
    input: RecordSupplierPurchaseRequest,
  ) {
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("record_supplier_purchase", {
        p_tenant: this.tenant(proof),
        p_actor: proof.authorization.membership.id,
        p_key: key,
        p_input: input,
      });
    if (error) throw supplierDatabaseError(error);
    return SupplierPurchaseSchema.parse(data);
  }
  async purchases(proof: AuthorizedOperationContext, query: SupplierPurchaseListQuery) {
    const sort = "supplier_purchases_id_desc";
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("list_supplier_purchases", {
        p_tenant: this.tenant(proof),
        p_supplier: query.supplierId ?? null,
        p_after: cursorId(query.cursor, sort),
        p_limit: query.limit + 1,
      });
    if (error) throw supplierDatabaseError(error);
    const rows = z.array(SupplierPurchaseSchema).parse(data);
    return SupplierPurchasesResponseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: pageInfo(
        rows.map((row) => row.id),
        query.limit,
        sort,
      ),
    });
  }
  async purchaseItems(proof: AuthorizedOperationContext, purchaseId: string) {
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("supplier_purchase_items", {
        p_tenant: this.tenant(proof),
        p_purchase: purchaseId,
      });
    if (error) throw supplierDatabaseError(error);
    return SupplierPurchaseItemsResponseSchema.parse({
      items: z.array(SupplierPurchaseItemSchema).parse(data),
    });
  }
  async recordPayment(
    proof: AuthorizedOperationContext,
    supplierId: string,
    key: string,
    input: RecordSupplierPaymentRequest,
  ) {
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("record_supplier_payment", {
        p_tenant: this.tenant(proof),
        p_supplier: supplierId,
        p_actor: proof.authorization.membership.id,
        p_key: key,
        p_input: input,
      });
    if (error) throw supplierDatabaseError(error);
    return SupplierPaymentSchema.parse(data);
  }
  async payments(proof: AuthorizedOperationContext, supplierId: string, query: SupplierPageQuery) {
    const sort = "supplier_payments_id_desc";
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("list_supplier_payments", {
        p_tenant: this.tenant(proof),
        p_supplier: supplierId,
        p_after: cursorId(query.cursor, sort),
        p_limit: query.limit + 1,
      });
    if (error) throw supplierDatabaseError(error);
    const rows = z.array(SupplierPaymentSchema).parse(data);
    return SupplierPaymentsResponseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: pageInfo(
        rows.map((row) => row.id),
        query.limit,
        sort,
      ),
    });
  }
  async dues(proof: AuthorizedOperationContext) {
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("supplier_dues", { p_tenant: this.tenant(proof) });
    if (error) throw supplierDatabaseError(error);
    return SupplierDuesResponseSchema.parse({ items: data });
  }
  async reminders(proof: AuthorizedOperationContext, query: SupplierReminderListQuery) {
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("list_supplier_reminders", {
        p_tenant: this.tenant(proof),
        p_supplier: query.supplierId ?? null,
        p_status: query.status ?? null,
        p_due_only: query.dueOnly ?? false,
      });
    if (error) throw supplierDatabaseError(error);
    return SupplierRemindersResponseSchema.parse({
      items: z.array(SupplierReminderSchema).parse(data),
    });
  }
  async writeReminder(
    proof: AuthorizedOperationContext,
    reminderId: string | null,
    key: string,
    input: CreateSupplierReminderRequest | UpdateSupplierReminderRequest,
  ) {
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("write_supplier_reminder", {
        p_tenant: this.tenant(proof),
        p_reminder: reminderId,
        p_actor: proof.authorization.membership.id,
        p_key: key,
        p_input: input,
        p_delete: false,
      });
    if (error) throw supplierDatabaseError(error);
    return SupplierReminderSchema.parse(data);
  }
  async deleteReminder(proof: AuthorizedOperationContext, reminderId: string, key: string) {
    const { data, error } = await this.client
      .schema("suppliers_private")
      .rpc("write_supplier_reminder", {
        p_tenant: this.tenant(proof),
        p_reminder: reminderId,
        p_actor: proof.authorization.membership.id,
        p_key: key,
        p_input: {},
        p_delete: true,
      });
    if (error) throw supplierDatabaseError(error);
    return DeleteSupplierReminderResponseSchema.parse(data);
  }
}
export function createSuppliersRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new SuppliersRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
