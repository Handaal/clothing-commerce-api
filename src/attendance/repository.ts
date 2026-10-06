import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  assertAuthorizedOperationProof,
  type AuthorizedOperationContext,
} from "../authorization";
import {
  AttendanceEntrySchema,
  AttendanceListResponseSchema,
  MyAttendanceResponseSchema,
} from "../contracts/management/attendance";
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
  return Buffer.from(JSON.stringify({ v: 1, sort: SORT, clockIn: entry.clockIn, id: entry.id })).toString(
    "base64url",
  );
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
    const { data, error } = await this.client
      .schema("attendance_private")
      .rpc("my_attendance", {
        p_tenant_id: this.tenant(proof),
        p_membership_id: this.membership(proof),
        p_limit: query.limit,
      });
    if (error) throw attendanceDatabaseError(error);
    return MyAttendanceResponseSchema.parse(data);
  }

  async list(proof: AuthorizedOperationContext, query: AttendanceListQuery) {
    const after = decodeCursor(query.cursor);
    const { data, error } = await this.client
      .schema("attendance_private")
      .rpc("list_attendance", {
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
}

export function createAttendanceRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new AttendanceRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
