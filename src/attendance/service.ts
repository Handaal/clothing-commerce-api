import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import { ClockInRequestSchema, type ClockInRequest } from "../contracts/management/attendance";
import { AttendanceError } from "./errors";
import {
  AttendanceListQuerySchema,
  MyAttendanceQuerySchema,
  type AttendanceListQuery,
  type MyAttendanceQuery,
} from "./request";
import type { AttendanceRepository } from "./repository";

// `record` is the self-service capability (clock the signed-in member in/out and read their own
// history); `read` is the tenant-wide management read of the whole workforce's entries.
export const AttendancePermission = {
  record: "attendance.record",
  read: "attendance.read",
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
}
