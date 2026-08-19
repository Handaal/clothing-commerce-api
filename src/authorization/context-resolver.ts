import type { ExternalIdentityVerifier } from "../authentication/external-identity";
import { AuthorizationError } from "./errors";
import {
  TenantSelectionSchema,
  type AuthorizationAssignmentRecord,
  type AuthorizationContext,
  type EffectiveAuthorizationAssignment,
  type VerifiedDeviceIdentity,
} from "./model";
import type { AuthorizationStateRepository } from "./repository";

export interface ResolveAuthorizationContextRequest {
  readonly request: Request;
  readonly requestedTenantId: string;
  /** Must come from a future verified device credential, never an arbitrary request header. */
  readonly verifiedDevice?: VerifiedDeviceIdentity;
}

export class AuthorizationContextResolver {
  constructor(
    private readonly identityVerifier: ExternalIdentityVerifier,
    private readonly repository: AuthorizationStateRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(input: ResolveAuthorizationContextRequest): Promise<AuthorizationContext> {
    const externalIdentity = await this.identityVerifier.verifyRequest(input.request);
    const requestedTenant = TenantSelectionSchema.safeParse(input.requestedTenantId);
    if (!requestedTenant.success) {
      throw new AuthorizationError("TENANT_ACCESS_DENIED");
    }

    const bindings = await this.repository.findProviderBindings(
      externalIdentity.provider,
      externalIdentity.subject,
    );
    if (bindings.length === 0) {
      throw new AuthorizationError("PROVIDER_BINDING_MISSING");
    }
    if (bindings.length !== 1 || bindings[0].unlinkedAt !== null) {
      throw new AuthorizationError("PROVIDER_BINDING_INVALID");
    }

    const binding = bindings[0];
    if (
      binding.provider !== externalIdentity.provider ||
      binding.providerSubject !== externalIdentity.subject
    ) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }

    const identities = await this.repository.findUserIdentities(binding.userIdentityId);
    if (identities.length !== 1 || identities[0].id !== binding.userIdentityId) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }
    const identity = identities[0];
    if (identity.status !== "active") {
      throw new AuthorizationError("IDENTITY_INACTIVE");
    }

    const memberships = await this.repository.findMemberships(requestedTenant.data, identity.id);
    if (memberships.length === 0) {
      throw new AuthorizationError("TENANT_ACCESS_DENIED");
    }
    if (memberships.length !== 1) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }
    const membership = memberships[0];
    if (membership.tenantId !== requestedTenant.data || membership.userIdentityId !== identity.id) {
      throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
    }
    if (membership.status !== "active") {
      throw new AuthorizationError("MEMBERSHIP_INACTIVE");
    }

    const tenants = await this.repository.findTenants(requestedTenant.data);
    if (tenants.length !== 1 || tenants[0].id !== requestedTenant.data) {
      throw new AuthorizationError("TENANT_ACCESS_DENIED");
    }
    const tenant = tenants[0];
    if (tenant.status === "suspended") {
      throw new AuthorizationError("TENANT_SUSPENDED");
    }
    if (tenant.status !== "active") {
      throw new AuthorizationError("TENANT_INACTIVE");
    }

    const device = input.verifiedDevice
      ? await this.resolveDevice(requestedTenant.data, input.verifiedDevice)
      : undefined;
    const assignmentRecords = await this.repository.loadAssignments(tenant.id, membership.id);
    const assignments = this.effectiveAssignments(assignmentRecords, tenant.id, membership.id);

    return {
      authentication: {
        provider: externalIdentity.provider,
        subject: externalIdentity.subject,
        ...(externalIdentity.sessionId ? { sessionId: externalIdentity.sessionId } : {}),
      },
      userIdentity: { id: identity.id },
      tenant: { id: tenant.id },
      membership: { id: membership.id },
      assignments,
      ...(device ? { device: { id: device.id } } : {}),
    };
  }

  private async resolveDevice(tenantId: string, verifiedDevice: VerifiedDeviceIdentity) {
    const devices = await this.repository.findDevices(tenantId, verifiedDevice.deviceId);
    if (devices.length !== 1 || devices[0].tenantId !== tenantId) {
      throw new AuthorizationError("TENANT_ACCESS_DENIED");
    }
    const device = devices[0];
    if (device.status === "revoked") {
      throw new AuthorizationError("DEVICE_REVOKED");
    }
    if (device.status !== "active") {
      throw new AuthorizationError("DEVICE_INACTIVE");
    }
    return device;
  }

  private effectiveAssignments(
    records: readonly AuthorizationAssignmentRecord[],
    tenantId: string,
    membershipId: string,
  ): EffectiveAuthorizationAssignment[] {
    const now = this.now().getTime();

    return records.flatMap((record) => {
      if (
        record.tenantId !== tenantId ||
        record.membershipId !== membershipId ||
        record.role.tenantId !== tenantId ||
        record.scope.tenantId !== tenantId
      ) {
        throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
      }

      const assignedAt = Date.parse(record.assignedAt);
      if (!Number.isFinite(assignedAt)) {
        throw new AuthorizationError("AUTHORIZATION_STATE_INVALID");
      }

      if (
        record.unassignedAt !== null ||
        assignedAt > now ||
        record.role.status !== "active" ||
        record.scope.status !== "active"
      ) {
        return [];
      }

      const permissionKeys = [
        ...new Set(
          record.permissions
            .filter((permission) => permission.status === "active")
            .map((permission) => permission.key),
        ),
      ];

      return [
        {
          assignmentId: record.id,
          roleId: record.role.id,
          isProtectedRole: record.role.isProtected,
          accessScopeId: record.scope.id,
          scopeMode: record.scope.mode,
          scopeTargets: record.scope.targets,
          permissionKeys,
        },
      ];
    });
  }
}
