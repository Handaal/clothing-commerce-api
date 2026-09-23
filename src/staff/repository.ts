import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  StaffDetailSchema,
  StaffSummarySchema,
  StaffListResponseSchema,
  EligibleIdentitySchema,
  EligibleIdentitiesResponseSchema,
  AssignableStaffRoleSchema,
  AssignableStaffRolesResponseSchema,
  AssignableStaffScopeSchema,
  AssignableStaffScopesResponseSchema,
  type AssignStaffRoleRequest,
  type CreateStaffRequest,
  type UpdateStaffStatusRequest,
} from "../contracts/management/staff";
import { InvalidCursorError } from "../management/cursor";
import { StaffError, staffDatabaseError } from "./errors";
import type { AssignmentCatalogQuery, EligibleIdentityLookup, StaffListQuery } from "./request";

const SORT = "staff_id_asc";
const ROLE_SORT = "role_name_asc";
const SCOPE_SORT = "scope_name_asc";

const CursorSchema = z.object({ v: z.literal(1), sort: z.literal(SORT), id: z.uuid() }).strict();

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

/**
 * The assignment catalogs are ordered by the tenant-unique normalized role/scope name, so their keyset is
 * that name rather than a uuid. The server returns it per row as `cursorKey`; the response schemas strip
 * it, so it never reaches a client except inside the opaque cursor.
 */
const CatalogCursorSchema = z
  .object({ v: z.literal(1), sort: z.string(), key: z.string().min(1).max(400) })
  .strict();

function catalogAfter(cursor: string | undefined, sort: string) {
  if (cursor === undefined) return null;
  try {
    const value = CatalogCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (value.sort !== sort) throw new Error();
    return value.key;
  } catch {
    throw new InvalidCursorError();
  }
}

function catalogPageInfo(keys: string[], limit: number, sort: string) {
  return {
    hasMore: keys.length > limit,
    nextCursor:
      keys.length > limit
        ? Buffer.from(JSON.stringify({ v: 1, sort, key: keys[limit - 1] })).toString("base64url")
        : null,
  };
}

const AssignableRoleRowSchema = AssignableStaffRoleSchema.extend({ cursorKey: z.string() });
const AssignableScopeRowSchema = AssignableStaffScopeSchema.extend({ cursorKey: z.string() });

export class StaffRepository {
  constructor(private readonly client: SupabaseClient) {}

  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }

  private actor(proof: AuthorizedOperationContext) {
    return proof.authorization.membership.id;
  }

  async list(proof: AuthorizedOperationContext, query: StaffListQuery) {
    const { data, error } = await this.client.schema("staff_private").rpc("list_staff", {
      p_tenant: this.tenant(proof),
      p_search: query.search ?? null,
      p_status: query.status ?? null,
      p_role: query.roleId ?? null,
      p_after: cursorId(query.cursor, SORT),
      p_limit: query.limit + 1,
    });
    if (error) throw staffDatabaseError(error);
    const rows = z.array(StaffSummarySchema).parse(data);
    return StaffListResponseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: pageInfo(
        rows.map((r) => r.membershipId),
        query.limit,
        SORT,
      ),
    });
  }

  async findEligibleIdentitiesByEmail(
    proof: AuthorizedOperationContext,
    lookup: EligibleIdentityLookup,
  ) {
    const { data, error } = await this.client
      .schema("staff_private")
      .rpc("find_eligible_identities_by_email", {
        p_tenant: this.tenant(proof),
        p_email: lookup.email,
      });
    if (error) throw staffDatabaseError(error);
    const rows = z.array(EligibleIdentitySchema).parse(data);
    return EligibleIdentitiesResponseSchema.parse({ items: rows });
  }

  // The actor is passed so the database applies the same subset-of-own-permissions filter the write
  // enforces; it is never taken from the client.
  async listAssignableRoles(proof: AuthorizedOperationContext, query: AssignmentCatalogQuery) {
    const { data, error } = await this.client.schema("staff_private").rpc("list_assignable_roles", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_after: catalogAfter(query.cursor, ROLE_SORT),
      p_limit: query.limit + 1,
    });
    if (error) throw staffDatabaseError(error);
    const rows = z.array(AssignableRoleRowSchema).parse(data);
    return AssignableStaffRolesResponseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: catalogPageInfo(
        rows.map((r) => r.cursorKey),
        query.limit,
        ROLE_SORT,
      ),
    });
  }

  async listAssignableScopes(proof: AuthorizedOperationContext, query: AssignmentCatalogQuery) {
    const { data, error } = await this.client
      .schema("staff_private")
      .rpc("list_assignable_scopes", {
        p_tenant: this.tenant(proof),
        p_after: catalogAfter(query.cursor, SCOPE_SORT),
        p_limit: query.limit + 1,
      });
    if (error) throw staffDatabaseError(error);
    const rows = z.array(AssignableScopeRowSchema).parse(data);
    return AssignableStaffScopesResponseSchema.parse({
      items: rows.slice(0, query.limit),
      pageInfo: catalogPageInfo(
        rows.map((r) => r.cursorKey),
        query.limit,
        SCOPE_SORT,
      ),
    });
  }

  async detail(proof: AuthorizedOperationContext, membershipId: string) {
    const { data, error } = await this.client.schema("staff_private").rpc("staff_detail_json", {
      p_tenant: this.tenant(proof),
      p_membership: membershipId,
    });
    if (error) throw staffDatabaseError(error);
    if (data === null) throw new StaffError("STAFF_NOT_FOUND");
    return StaffDetailSchema.parse(data);
  }

  async create(proof: AuthorizedOperationContext, key: string, input: CreateStaffRequest) {
    const { data, error } = await this.client.schema("staff_private").rpc("create_staff", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_key: key,
      p_identity: input.identityId,
    });
    if (error) throw staffDatabaseError(error);
    return StaffDetailSchema.parse(data);
  }

  async setStatus(
    proof: AuthorizedOperationContext,
    membershipId: string,
    key: string,
    input: UpdateStaffStatusRequest,
  ) {
    const { data, error } = await this.client.schema("staff_private").rpc("set_staff_status", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_key: key,
      p_membership: membershipId,
      p_status: input.status,
      p_reason: input.reason ?? null,
    });
    if (error) throw staffDatabaseError(error);
    return StaffDetailSchema.parse(data);
  }

  async assignRole(
    proof: AuthorizedOperationContext,
    membershipId: string,
    key: string,
    input: AssignStaffRoleRequest,
  ) {
    const { data, error } = await this.client.schema("staff_private").rpc("assign_role", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_key: key,
      p_membership: membershipId,
      p_role: input.roleId,
      p_scope: input.accessScopeId,
      p_reason: input.reason ?? null,
    });
    if (error) throw staffDatabaseError(error);
    return StaffDetailSchema.parse(data);
  }

  async unassignRole(
    proof: AuthorizedOperationContext,
    membershipId: string,
    assignmentId: string,
    key: string,
    reason: string | null,
  ) {
    const { data, error } = await this.client.schema("staff_private").rpc("unassign_role", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_key: key,
      p_membership: membershipId,
      p_assignment: assignmentId,
      p_reason: reason,
    });
    if (error) throw staffDatabaseError(error);
    return StaffDetailSchema.parse(data);
  }
}

export function createStaffRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new StaffRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
