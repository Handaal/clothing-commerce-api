import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  AttendanceEntrySchema,
  AttendanceListResponseSchema,
  MyAttendanceResponseSchema,
} from "../contracts/management/attendance";
import {
  AdjustmentSchema,
  AdjustmentListResponseSchema,
  EmployeeCompensationSchema,
  LeaveEntrySchema,
  LeaveListResponseSchema,
  PayrollRowSchema,
  PayrollReportResponseSchema,
  PayrollSettingsSchema,
  type CreateAdjustmentRequest,
  type CreateAttendanceEntryRequest,
  type SetCompensationRequest,
  type UpdateAttendanceEntryRequest,
  type UpdatePayrollSettingsRequest,
} from "../contracts/management/attendance-payroll";
import { InvalidCursorError } from "../management/cursor";
import { attendanceDatabaseError } from "./errors";
import type { AttendanceListQuery, MyAttendanceQuery } from "./request";

const SORT = "attendance_clock_in_desc";
const CursorSchema = z
  .object({ v: z.literal(1), sort: z.literal(SORT), clockIn: z.string(), id: z.uuid() })
  .strict();

function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  try {
    const value = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { clockIn: value.clockIn, id: value.id };
  } catch {
    throw new InvalidCursorError();
  }
}

function encodeCursor(entry: { clockIn: string; id: string }) {
  return Buffer.from(
    JSON.stringify({ v: 1, sort: SORT, clockIn: entry.clockIn, id: entry.id }),
  ).toString("base64url");
}

export class AttendanceRepository {
  constructor(private readonly client: SupabaseClient) {}
  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }
  private membership(proof: AuthorizedOperationContext) {
    return proof.authorization.membership.id;
  }

  async clockIn(proof: AuthorizedOperationContext, branchId: string | null) {
    const tenant = this.tenant(proof);
    const { data: id, error } = await this.client.schema("attendance_private").rpc("clock_in", {
      p_tenant_id: tenant,
      p_membership_id: this.membership(proof),
      p_branch_id: branchId,
    });
    if (error) throw attendanceDatabaseError(error);
    return this.entry(tenant, z.uuid().parse(id));
  }

  async clockOut(proof: AuthorizedOperationContext) {
    const tenant = this.tenant(proof);
    const { data: id, error } = await this.client.schema("attendance_private").rpc("clock_out", {
      p_tenant_id: tenant,
      p_membership_id: this.membership(proof),
    });
    if (error) throw attendanceDatabaseError(error);
    return this.entry(tenant, z.uuid().parse(id));
  }

  private async entry(tenant: string, id: string) {
    const { data, error } = await this.client
      .schema("attendance_private")
      .rpc("get_entry", { p_tenant_id: tenant, p_id: id });
    if (error) throw attendanceDatabaseError(error);
    return { entry: AttendanceEntrySchema.parse(data) };
  }

  async mine(proof: AuthorizedOperationContext, query: MyAttendanceQuery) {
    const { data, error } = await this.client.schema("attendance_private").rpc("my_attendance", {
      p_tenant_id: this.tenant(proof),
      p_membership_id: this.membership(proof),
      p_limit: query.limit,
    });
    if (error) throw attendanceDatabaseError(error);
    return MyAttendanceResponseSchema.parse(data);
  }

  async list(proof: AuthorizedOperationContext, query: AttendanceListQuery) {
    const after = decodeCursor(query.cursor);
    const { data, error } = await this.client.schema("attendance_private").rpc("list_attendance", {
      p_tenant_id: this.tenant(proof),
      p_membership_id: query.membershipId ?? null,
      p_branch_id: query.branchId ?? null,
      p_after_clock_in: after?.clockIn ?? null,
      p_after_id: after?.id ?? null,
      p_limit: query.limit + 1,
    });
    if (error) throw attendanceDatabaseError(error);
    const rows = z.array(AttendanceEntrySchema).parse(data);
    const items = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const last = items[items.length - 1];
    return AttendanceListResponseSchema.parse({
      items,
      pageInfo: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ clockIn: last.clockIn, id: last.id }) : null,
      },
    });
  }

  private rpc(name: string, params: Record<string, unknown>) {
    return this.client.schema("attendance_private").rpc(name, params);
  }

  // ── Payroll ────────────────────────────────────────────────────────────────
  async payroll(proof: AuthorizedOperationContext, from: string, to: string) {
    const { data, error } = await this.rpc("payroll", {
      p_tenant_id: this.tenant(proof),
      p_from: from,
      p_to: to,
    });
    if (error) throw attendanceDatabaseError(error);
    const items = z.array(PayrollRowSchema).parse(data ?? []);
    const totals = items.reduce(
      (t, r) => ({
        baseSalaryMinor: t.baseSalaryMinor + r.baseSalaryMinor,
        overtimeAmountMinor: t.overtimeAmountMinor + r.overtimeAmountMinor,
        bonusMinor: t.bonusMinor + r.bonusMinor,
        deductionMinor: t.deductionMinor + r.deductionMinor,
        netPayMinor: t.netPayMinor + r.netPayMinor,
      }),
      {
        baseSalaryMinor: 0,
        overtimeAmountMinor: 0,
        bonusMinor: 0,
        deductionMinor: 0,
        netPayMinor: 0,
      },
    );
    return PayrollReportResponseSchema.parse({ items, totals });
  }

  async getPayrollSettings(proof: AuthorizedOperationContext) {
    const { data, error } = await this.rpc("get_payroll_settings", {
      p_tenant_id: this.tenant(proof),
    });
    if (error) throw attendanceDatabaseError(error);
    return PayrollSettingsSchema.parse(data);
  }

  async updatePayrollSettings(
    proof: AuthorizedOperationContext,
    input: UpdatePayrollSettingsRequest,
  ) {
    const { data, error } = await this.rpc("upsert_payroll_settings", {
      p_tenant_id: this.tenant(proof),
      p_normal_hours: input.normalHours,
      p_shift_hours: input.shiftDurationHours,
    });
    if (error) throw attendanceDatabaseError(error);
    return PayrollSettingsSchema.parse(data);
  }

  // ── Compensation ─────────────────────────────────────────────────────────────
  async getCompensation(proof: AuthorizedOperationContext, membershipId: string) {
    const { data, error } = await this.rpc("get_compensation", {
      p_tenant_id: this.tenant(proof),
      p_membership_id: membershipId,
    });
    if (error) throw attendanceDatabaseError(error);
    return data ? EmployeeCompensationSchema.parse(data) : null;
  }

  async setCompensation(
    proof: AuthorizedOperationContext,
    membershipId: string,
    input: SetCompensationRequest,
  ) {
    const { data, error } = await this.rpc("set_compensation", {
      p_tenant_id: this.tenant(proof),
      p_membership_id: membershipId,
      p_base_minor: input.baseSalaryMinor,
      p_ot_rate_minor: input.overtimeRateMinor,
      p_normal_hours: input.normalHours,
      p_currency: input.currency,
    });
    if (error) throw attendanceDatabaseError(error);
    return EmployeeCompensationSchema.parse(data);
  }

  // ── Adjustments ──────────────────────────────────────────────────────────────
  async listAdjustments(proof: AuthorizedOperationContext, from: string, to: string) {
    const { data, error } = await this.rpc("list_adjustments", {
      p_tenant_id: this.tenant(proof),
      p_from: from,
      p_to: to,
    });
    if (error) throw attendanceDatabaseError(error);
    return AdjustmentListResponseSchema.parse({
      items: z.array(AdjustmentSchema).parse(data ?? []),
    });
  }

  async createAdjustment(proof: AuthorizedOperationContext, input: CreateAdjustmentRequest) {
    const { data, error } = await this.rpc("add_adjustment", {
      p_tenant_id: this.tenant(proof),
      p_membership_id: input.membershipId,
      p_type: input.type,
      p_amount_minor: input.amountMinor,
      p_reason: input.reason ?? null,
      p_date: input.effectiveDate ?? null,
      p_hours: input.hours ?? null,
      p_actor: this.membership(proof),
    });
    if (error) throw attendanceDatabaseError(error);
    return AdjustmentSchema.parse(data);
  }

  async removeAdjustment(proof: AuthorizedOperationContext, id: string) {
    const { error } = await this.rpc("remove_adjustment", {
      p_tenant_id: this.tenant(proof),
      p_id: id,
    });
    if (error) throw attendanceDatabaseError(error);
    return { id };
  }

  // ── Leave log ────────────────────────────────────────────────────────────────
  async listLeaves(proof: AuthorizedOperationContext, from: string, to: string) {
    const { data, error } = await this.rpc("list_leaves", {
      p_tenant_id: this.tenant(proof),
      p_from: from,
      p_to: to,
    });
    if (error) throw attendanceDatabaseError(error);
    return LeaveListResponseSchema.parse({ items: z.array(LeaveEntrySchema).parse(data ?? []) });
  }

  async leaveStart(proof: AuthorizedOperationContext, branchId: string | null) {
    const tenant = this.tenant(proof);
    const { data: id, error } = await this.rpc("leave_start", {
      p_tenant_id: tenant,
      p_membership_id: this.membership(proof),
      p_branch_id: branchId,
    });
    if (error) throw attendanceDatabaseError(error);
    return this.leaveEntry(tenant, z.uuid().parse(id));
  }

  async leaveEnd(proof: AuthorizedOperationContext) {
    const tenant = this.tenant(proof);
    const { data: id, error } = await this.rpc("leave_end", {
      p_tenant_id: tenant,
      p_membership_id: this.membership(proof),
    });
    if (error) throw attendanceDatabaseError(error);
    return this.leaveEntry(tenant, z.uuid().parse(id));
  }

  private async leaveEntry(tenant: string, id: string) {
    const { data, error } = await this.rpc("get_leave_entry", { p_tenant_id: tenant, p_id: id });
    if (error) throw attendanceDatabaseError(error);
    return { entry: LeaveEntrySchema.parse(data) };
  }

  // ── Manager-sanctioned manual entries ─────────────────────────────────────────
  async createEntry(proof: AuthorizedOperationContext, input: CreateAttendanceEntryRequest) {
    const tenant = this.tenant(proof);
    const { data: id, error } = await this.rpc("admin_upsert_entry", {
      p_tenant_id: tenant,
      p_membership_id: input.membershipId,
      p_branch_id: input.branchId ?? null,
      p_clock_in: input.clockIn,
      p_clock_out: input.clockOut ?? null,
      p_id: null,
    });
    if (error) throw attendanceDatabaseError(error);
    return this.entry(tenant, z.uuid().parse(id));
  }

  async updateEntry(
    proof: AuthorizedOperationContext,
    entryId: string,
    input: UpdateAttendanceEntryRequest,
  ) {
    const tenant = this.tenant(proof);
    const { data: id, error } = await this.rpc("admin_upsert_entry", {
      p_tenant_id: tenant,
      p_membership_id: null,
      p_branch_id: input.branchId ?? null,
      p_clock_in: input.clockIn ?? null,
      p_clock_out: input.clockOut ?? null,
      p_id: entryId,
    });
    if (error) throw attendanceDatabaseError(error);
    return this.entry(tenant, z.uuid().parse(id));
  }

  async removeEntry(proof: AuthorizedOperationContext, entryId: string) {
    const { error } = await this.rpc("admin_delete_entry", {
      p_tenant_id: this.tenant(proof),
      p_id: entryId,
    });
    if (error) throw attendanceDatabaseError(error);
    return { id: entryId };
  }
}

export function createAttendanceRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new AttendanceRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
