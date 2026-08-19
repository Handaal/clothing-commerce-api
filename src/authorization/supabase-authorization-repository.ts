import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { AuthorizationError } from "./errors";
import {
  AuthorizationResourceSchema,
  type AuthorizationAssignmentRecord,
  type AuthorizationResource,
  type DeviceRecord,
  type MembershipRecord,
  type ProviderBindingRecord,
  type TenantRecord,
  type UserIdentityRecord,
} from "./model";
import type { AuthorizationStateRepository } from "./repository";

const ProviderBindingRowSchema = z.object({
  id: z.string().uuid(),
  user_identity_id: z.string().uuid(),
  provider: z.string().min(1),
  provider_subject: z.string().min(1),
  unlinked_at: z.string().nullable(),
});

const UserIdentityRowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["active", "suspended", "deactivated"]),
});

const TenantRowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
});

const MembershipRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  user_identity_id: z.string().uuid(),
  status: z.enum(["invited", "active", "suspended", "deactivated"]),
});

const DeviceRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  status: z.enum(["enrolled", "active", "revoked"]),
});

const AssignmentRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  membership_id: z.string().uuid(),
  role_id: z.string().uuid(),
  access_scope_id: z.string().uuid(),
  assigned_at: z.string().min(1),
  unassigned_at: z.string().nullable(),
});

const RoleRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  status: z.enum(["active", "archived"]),
  is_protected: z.boolean(),
});

const ScopeRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  scope_mode: z.enum(["tenant", "explicit"]),
  status: z.enum(["active", "archived"]),
});

const ScopeTargetRowSchema = z.object({
  brand_id: z.string().uuid().nullable(),
  branch_id: z.string().uuid().nullable(),
  warehouse_id: z.string().uuid().nullable(),
  inventory_location_id: z.string().uuid().nullable(),
});

const RolePermissionRowSchema = z.object({ permission_id: z.string().uuid() });
const PermissionRowSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  status: z.enum(["active", "deprecated"]),
});
const TenantIdRowSchema = z.object({ tenant_id: z.string().uuid() });

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
  }
  return parsed.data;
}

function requireNoQueryError(error: unknown): void {
  if (error) {
    throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
  }
}

/**
 * Server-only adapter around a service-role client. The client is deliberately private and this
 * class exposes no write method or generic query escape hatch.
 */
export class SupabaseAuthorizationRepository implements AuthorizationStateRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findProviderBindings(
    provider: string,
    providerSubject: string,
  ): Promise<ProviderBindingRecord[]> {
    const { data, error } = await this.client
      .from("user_identity_provider_bindings")
      .select("id,user_identity_id,provider,provider_subject,unlinked_at")
      .eq("provider", provider)
      .eq("provider_subject", providerSubject)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(ProviderBindingRowSchema, data).map((row) => ({
      id: row.id,
      userIdentityId: row.user_identity_id,
      provider: row.provider,
      providerSubject: row.provider_subject,
      unlinkedAt: row.unlinked_at,
    }));
  }

  async findUserIdentities(id: string): Promise<UserIdentityRecord[]> {
    const { data, error } = await this.client
      .from("user_identities")
      .select("id,status")
      .eq("id", id)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(UserIdentityRowSchema, data);
  }

  async findTenants(id: string): Promise<TenantRecord[]> {
    const { data, error } = await this.client
      .from("tenants")
      .select("id,status")
      .eq("id", id)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(TenantRowSchema, data);
  }

  async findMemberships(tenantId: string, userIdentityId: string): Promise<MembershipRecord[]> {
    const { data, error } = await this.client
      .from("memberships")
      .select("id,tenant_id,user_identity_id,status")
      .eq("tenant_id", tenantId)
      .eq("user_identity_id", userIdentityId)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(MembershipRowSchema, data).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      userIdentityId: row.user_identity_id,
      status: row.status,
    }));
  }

  async findDevices(tenantId: string, deviceId: string): Promise<DeviceRecord[]> {
    const { data, error } = await this.client
      .from("devices")
      .select("id,tenant_id,status")
      .eq("tenant_id", tenantId)
      .eq("id", deviceId)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(DeviceRowSchema, data).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      status: row.status,
    }));
  }

  async loadAssignments(
    tenantId: string,
    membershipId: string,
  ): Promise<AuthorizationAssignmentRecord[]> {
    const { data, error } = await this.client
      .from("membership_role_assignments")
      .select("id,tenant_id,membership_id,role_id,access_scope_id,assigned_at,unassigned_at")
      .eq("tenant_id", tenantId)
      .eq("membership_id", membershipId);
    requireNoQueryError(error);
    const assignments = parseRows(AssignmentRowSchema, data);
    return Promise.all(assignments.map((assignment) => this.hydrateAssignment(assignment)));
  }

  async findResourceTenantIds(resource: AuthorizationResource): Promise<string[]> {
    const tableByKind = {
      brand: "brands",
      branch: "branches",
      warehouse: "warehouses",
      inventory_location: "inventory_locations",
    } as const;
    const { data, error } = await this.client
      .from(tableByKind[resource.kind])
      .select("tenant_id")
      .eq("id", resource.id)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(TenantIdRowSchema, data).map((row) => row.tenant_id);
  }

  private async hydrateAssignment(
    assignment: z.infer<typeof AssignmentRowSchema>,
  ): Promise<AuthorizationAssignmentRecord> {
    const [roleResult, scopeResult, targetResult, rolePermissionResult] = await Promise.all([
      this.client
        .from("roles")
        .select("id,tenant_id,status,is_protected")
        .eq("tenant_id", assignment.tenant_id)
        .eq("id", assignment.role_id)
        .limit(2),
      this.client
        .from("access_scopes")
        .select("id,tenant_id,scope_mode,status")
        .eq("tenant_id", assignment.tenant_id)
        .eq("id", assignment.access_scope_id)
        .limit(2),
      this.client
        .from("access_scope_targets")
        .select("brand_id,branch_id,warehouse_id,inventory_location_id")
        .eq("tenant_id", assignment.tenant_id)
        .eq("access_scope_id", assignment.access_scope_id),
      this.client
        .from("role_permissions")
        .select("permission_id")
        .eq("tenant_id", assignment.tenant_id)
        .eq("role_id", assignment.role_id),
    ]);

    for (const result of [roleResult, scopeResult, targetResult, rolePermissionResult]) {
      requireNoQueryError(result.error);
    }

    const roles = parseRows(RoleRowSchema, roleResult.data);
    const scopes = parseRows(ScopeRowSchema, scopeResult.data);
    if (roles.length !== 1 || scopes.length !== 1) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }

    const rolePermissionRows = parseRows(RolePermissionRowSchema, rolePermissionResult.data);
    const permissionIds = rolePermissionRows.map((row) => row.permission_id);
    const permissions = await this.loadPermissions(permissionIds);
    const targets = parseRows(ScopeTargetRowSchema, targetResult.data).map((target) =>
      this.mapScopeTarget(target),
    );
    const scope = scopes[0];
    if (scope.scope_mode === "tenant" && targets.length > 0) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }

    const role = roles[0];
    return {
      id: assignment.id,
      tenantId: assignment.tenant_id,
      membershipId: assignment.membership_id,
      assignedAt: assignment.assigned_at,
      unassignedAt: assignment.unassigned_at,
      role: {
        id: role.id,
        tenantId: role.tenant_id,
        status: role.status,
        isProtected: role.is_protected,
      },
      scope: {
        id: scope.id,
        tenantId: scope.tenant_id,
        status: scope.status,
        mode: scope.scope_mode,
        targets,
      },
      permissions: permissions.map((permission) => ({
        key: permission.key,
        status: permission.status,
      })),
    };
  }

  private async loadPermissions(permissionIds: readonly string[]) {
    if (permissionIds.length === 0) {
      return [];
    }

    const { data, error } = await this.client
      .from("permissions")
      .select("id,key,status")
      .in("id", [...new Set(permissionIds)]);
    requireNoQueryError(error);
    const permissions = parseRows(PermissionRowSchema, data);
    if (permissions.length !== new Set(permissionIds).size) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }
    return permissions;
  }

  private mapScopeTarget(target: z.infer<typeof ScopeTargetRowSchema>): AuthorizationResource {
    const candidates = [
      target.brand_id ? { kind: "brand" as const, id: target.brand_id } : null,
      target.branch_id ? { kind: "branch" as const, id: target.branch_id } : null,
      target.warehouse_id ? { kind: "warehouse" as const, id: target.warehouse_id } : null,
      target.inventory_location_id
        ? { kind: "inventory_location" as const, id: target.inventory_location_id }
        : null,
    ].filter((candidate): candidate is AuthorizationResource => candidate !== null);

    if (candidates.length !== 1) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }
    return AuthorizationResourceSchema.parse(candidates[0]);
  }
}

export interface SupabaseAuthorizationRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseAuthorizationRepository(
  configuration: SupabaseAuthorizationRepositoryConfiguration,
): SupabaseAuthorizationRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseAuthorizationRepository(client);
}
