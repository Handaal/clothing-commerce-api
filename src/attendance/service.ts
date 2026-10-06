import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import { ClockInRequestSchema, type ClockInRequest } from "../contracts/management/attendance";
import {
  CreateAdjustmentRequestSchema,
  CreateAttendanceEntryRequestSchema,
  LeaveStartRequestSchema,
  SetCompensationRequestSchema,
  UpdateAttendanceEntryRequestSchema,
  UpdatePayrollSettingsRequestSchema,
  type CreateAdjustmentRequest,
  type CreateAttendanceEntryRequest,
  type LeaveStartRequest,
  type SetCompensationRequest,
  type UpdateAttendanceEntryRequest,
  type UpdatePayrollSettingsRequest,
} from "../contracts/management/attendance-payroll";
import { AttendanceError } from "./errors";
import {
  AttendanceListQuerySchema,
  DateRangeQuerySchema,
  MyAttendanceQuerySchema,
  type AttendanceListQuery,
  type DateRangeQuery,
  type MyAttendanceQuery,
} from "./request";
import type { AttendanceRepository } from "./repository";

// `record` is the self-service capability (clock the signed-in member in/out, read their own history,
// start/end their own leave); `read` is the tenant-wide management read of the whole workforce's
// attendance + payroll; `manage` is the admin write surface (compensation, adjustments, payroll
// settings, manual entry add/edit/delete).
export const AttendancePermission = {
  record: "attendance.record",
  read: "attendance.read",
  manage: "attendance.manage",
} as const;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AttendanceError("INVALID_ATTENDANCE");
  return result.data;
}

export class AttendanceService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: AttendanceRepository,
  ) {}
  private authorize(context: AuthorizationContext, permissionKey: string) {
    // No resource target: the shared authorizer requires a permission-coupled tenant-wide grant.
    return this.authorization.authorize(context, { permissionKey });
  }

  async clockIn(context: AuthorizationContext, input: ClockInRequest) {
    const body = parse(ClockInRequestSchema, input);
    return this.repository.clockIn(
      await this.authorize(context, AttendancePermission.record),
      body.branchId ?? null,
    );
  }

  async clockOut(context: AuthorizationContext) {
    return this.repository.clockOut(await this.authorize(context, AttendancePermission.record));
  }

  async mine(context: AuthorizationContext, query: MyAttendanceQuery) {
    return this.repository.mine(
      await this.authorize(context, AttendancePermission.record),
      parse(MyAttendanceQuerySchema, query),
    );
  }

  async list(context: AuthorizationContext, query: AttendanceListQuery) {
    return this.repository.list(
      await this.authorize(context, AttendancePermission.read),
      parse(AttendanceListQuerySchema, query),
    );
  }

  // ── Payroll (read) ───────────────────────────────────────────────────────────
  async payroll(context: AuthorizationContext, query: DateRangeQuery) {
    const { from, to } = parse(DateRangeQuerySchema, query);
    return this.repository.payroll(await this.authorize(context, AttendancePermission.read), from, to);
  }

  async getPayrollSettings(context: AuthorizationContext) {
    return this.repository.getPayrollSettings(await this.authorize(context, AttendancePermission.read));
  }

  async getCompensation(context: AuthorizationContext, membershipId: string) {
    return this.repository.getCompensation(
      await this.authorize(context, AttendancePermission.read),
      parse(z.uuid(), membershipId),
    );
  }

  async listAdjustments(context: AuthorizationContext, query: DateRangeQuery) {
    const { from, to } = parse(DateRangeQuerySchema, query);
    return this.repository.listAdjustments(
      await this.authorize(context, AttendancePermission.read),
      from,
      to,
    );
  }

  async listLeaves(context: AuthorizationContext, query: DateRangeQuery) {
    const { from, to } = parse(DateRangeQuerySchema, query);
    return this.repository.listLeaves(
      await this.authorize(context, AttendancePermission.read),
      from,
      to,
    );
  }

  // ── Payroll (manage) ───────────────────────────────────────────────────────
  async updatePayrollSettings(context: AuthorizationContext, input: UpdatePayrollSettingsRequest) {
    return this.repository.updatePayrollSettings(
      await this.authorize(context, AttendancePermission.manage),
      parse(UpdatePayrollSettingsRequestSchema, input),
    );
  }

  async setCompensation(
    context: AuthorizationContext,
    membershipId: string,
    input: SetCompensationRequest,
  ) {
    return this.repository.setCompensation(
      await this.authorize(context, AttendancePermission.manage),
      parse(z.uuid(), membershipId),
      parse(SetCompensationRequestSchema, input),
    );
  }

  async createAdjustment(context: AuthorizationContext, input: CreateAdjustmentRequest) {
    return this.repository.createAdjustment(
      await this.authorize(context, AttendancePermission.manage),
      parse(CreateAdjustmentRequestSchema, input),
    );
  }

  async removeAdjustment(context: AuthorizationContext, id: string) {
    return this.repository.removeAdjustment(
      await this.authorize(context, AttendancePermission.manage),
      parse(z.uuid(), id),
    );
  }

  async createEntry(context: AuthorizationContext, input: CreateAttendanceEntryRequest) {
    return this.repository.createEntry(
      await this.authorize(context, AttendancePermission.manage),
      parse(CreateAttendanceEntryRequestSchema, input),
    );
  }

  async updateEntry(
    context: AuthorizationContext,
    entryId: string,
    input: UpdateAttendanceEntryRequest,
  ) {
    return this.repository.updateEntry(
      await this.authorize(context, AttendancePermission.manage),
      parse(z.uuid(), entryId),
      parse(UpdateAttendanceEntryRequestSchema, input),
    );
  }

  async removeEntry(context: AuthorizationContext, entryId: string) {
    return this.repository.removeEntry(
      await this.authorize(context, AttendancePermission.manage),
      parse(z.uuid(), entryId),
    );
  }

  // ── Leave (self-service) ─────────────────────────────────────────────────────
  async leaveStart(context: AuthorizationContext, input: LeaveStartRequest) {
    const body = parse(LeaveStartRequestSchema, input);
    return this.repository.leaveStart(
      await this.authorize(context, AttendancePermission.record),
      body.branchId ?? null,
    );
  }

  async leaveEnd(context: AuthorizationContext) {
    return this.repository.leaveEnd(await this.authorize(context, AttendancePermission.record));
  }
}
