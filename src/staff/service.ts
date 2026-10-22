import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import {
  AssignStaffRoleRequestSchema,
  CreateStaffRequestSchema,
  CreateStaffLoginRequestSchema,
  UnassignStaffRoleRequestSchema,
  UpdateStaffStatusRequestSchema,
  type AssignStaffRoleRequest,
  type CreateStaffRequest,
  type CreateStaffLoginRequest,
  type UnassignStaffRoleRequest,
  type UpdateStaffStatusRequest,
} from "../contracts/management/staff";
import type { StaffLoginProvisioner } from "../authentication/staff-login-provisioner";
import { StaffError } from "./errors";
import {
  AssignmentCatalogQuerySchema,
  EligibleIdentityLookupSchema,
  StaffListQuerySchema,
  type AssignmentCatalogQuery,
  type EligibleIdentityLookup,
  type StaffListQuery,
} from "./request";
import type { StaffRepository } from "./repository";

export const StaffPermission = { read: "staff.read", manage: "staff.manage" } as const;

/**
 * UI capability guidance for /me/context. Staff management is a tenant-owned concern, so — like the
 * suppliers surface — a capability is only reported when the caller holds the permission tenant-wide.
 * It never grants access: every operation re-authorizes server-side against the same tenant-wide grant.
 */
export function staffCapabilities(context: AuthorizationContext) {
  const has = (key: string) =>
    context.assignments.some((a) => a.scopeMode === "tenant" && a.permissionKeys.includes(key));
  return { canRead: has(StaffPermission.read), canManage: has(StaffPermission.manage) };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new StaffError("INVALID_STAFF");
  return result.data;
}

export class StaffService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: StaffRepository,
    private readonly loginProvisioner: StaffLoginProvisioner,
  ) {}

  // No resource target: the shared authorizer requires a permission-coupled tenant-wide grant, so a
  // brand/branch-scoped grant is insufficient to read or manage staff.
  private authorize(context: AuthorizationContext, permissionKey: string) {
    return this.authorization.authorize(context, { permissionKey });
  }

  async list(context: AuthorizationContext, query: StaffListQuery) {
    return this.repository.list(
      await this.authorize(context, StaffPermission.read),
      parse(StaffListQuerySchema, query),
    );
  }

  // Add-Staff identity resolution is an exact-email lookup, part of the add-staff flow, so it requires
  // the same tenant-wide staff.manage grant. It returns only linkable (active, not-already-a-member)
  // identities that match the given email exactly, with a minimal projection — never a directory search.
  async findEligibleIdentitiesByEmail(
    context: AuthorizationContext,
    lookup: EligibleIdentityLookup,
  ) {
    return this.repository.findEligibleIdentitiesByEmail(
      await this.authorize(context, StaffPermission.manage),
      parse(EligibleIdentityLookupSchema, lookup),
    );
  }

  // The assignment catalogs exist only to populate the Add/Edit Staff assignment picker, so they are
  // management-only: they require the same tenant-wide staff.manage grant as the assignment write, and a
  // staff.read-only caller cannot reach them. The role catalog additionally applies the write's own
  // subset-of-own-permissions rule; the write remains authoritative and re-checks it independently.
  async listAssignableRoles(context: AuthorizationContext, query: AssignmentCatalogQuery) {
    return this.repository.listAssignableRoles(
      await this.authorize(context, StaffPermission.manage),
      parse(AssignmentCatalogQuerySchema, query),
    );
  }

  async listAssignableScopes(context: AuthorizationContext, query: AssignmentCatalogQuery) {
    return this.repository.listAssignableScopes(
      await this.authorize(context, StaffPermission.manage),
      parse(AssignmentCatalogQuerySchema, query),
    );
  }

  async detail(context: AuthorizationContext, membershipId: string) {
    return this.repository.detail(
      await this.authorize(context, StaffPermission.read),
      parse(z.uuid(), membershipId),
    );
  }

  async create(context: AuthorizationContext, key: string, input: CreateStaffRequest) {
    return this.repository.create(
      await this.authorize(context, StaffPermission.manage),
      key,
      parse(CreateStaffRequestSchema, input),
    );
  }

  /**
   * Provision an email-less staff LOGIN (external account + identity + binding + membership + initial
   * assignment) in one step. The order is deliberate and fail-closed:
   *   1. authorize tenant-wide staff.manage — an unauthorized caller never reaches the external provider;
   *   2. replay-probe the ledger — a genuine idempotent retry returns the stored staff WITHOUT re-minting;
   *   3. mint the external login and capture the SERVER-verified subject (never client-supplied);
   *   4. persist the graph; the subset/anti-escalation and lifecycle rules all live in the RPC.
   * If step 4 loses an idempotency race (two first-time submits of the same key), the just-minted external
   * account is orphaned, so it is deleted best-effort before the conflict surfaces.
   */
  async createLogin(context: AuthorizationContext, key: string, input: CreateStaffLoginRequest) {
    const proof = await this.authorize(context, StaffPermission.manage);
    const parsed = parse(CreateStaffLoginRequestSchema, input);

    const replay = await this.repository.peekCommand(proof, key);
    if (replay !== null) return replay;

    const subject = await this.loginProvisioner.provisionLogin({
      username: parsed.username,
      pin: parsed.pin,
      displayName: parsed.displayName,
    });
    try {
      return await this.repository.createLogin(proof, key, subject, parsed);
    } catch (error) {
      if (error instanceof StaffError && error.code === "IDEMPOTENCY_CONFLICT") {
        await this.loginProvisioner.deleteLogin(subject);
      }
      throw error;
    }
  }

  async updateStatus(
    context: AuthorizationContext,
    membershipId: string,
    key: string,
    input: UpdateStaffStatusRequest,
  ) {
    return this.repository.setStatus(
      await this.authorize(context, StaffPermission.manage),
      parse(z.uuid(), membershipId),
      key,
      parse(UpdateStaffStatusRequestSchema, input),
    );
  }

  async assignRole(
    context: AuthorizationContext,
    membershipId: string,
    key: string,
    input: AssignStaffRoleRequest,
  ) {
    return this.repository.assignRole(
      await this.authorize(context, StaffPermission.manage),
      parse(z.uuid(), membershipId),
      key,
      parse(AssignStaffRoleRequestSchema, input),
    );
  }

  async unassignRole(
    context: AuthorizationContext,
    membershipId: string,
    assignmentId: string,
    key: string,
    input: UnassignStaffRoleRequest,
  ) {
    const parsed = parse(UnassignStaffRoleRequestSchema, input);
    return this.repository.unassignRole(
      await this.authorize(context, StaffPermission.manage),
      parse(z.uuid(), membershipId),
      parse(z.uuid(), assignmentId),
      key,
      parsed.reason ?? null,
    );
  }
}
