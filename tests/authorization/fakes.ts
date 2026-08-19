import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import type {
  AuthorizationAssignmentRecord,
  AuthorizationResource,
  DeviceRecord,
  MembershipRecord,
  ProviderBindingRecord,
  TenantRecord,
  UserIdentityRecord,
  VerifiedExternalIdentity,
} from "../../src/authorization/model";
import type { AuthorizationStateRepository } from "../../src/authorization/repository";

export const ids = {
  tenantA: "10000000-0000-4000-8000-000000000001",
  tenantB: "10000000-0000-4000-8000-000000000002",
  tenantC: "10000000-0000-4000-8000-000000000003",
  user: "70000000-0000-4000-8000-000000000001",
  otherUser: "70000000-0000-4000-8000-000000000002",
  membershipA: "80000000-0000-4000-8000-000000000001",
  membershipB: "80000000-0000-4000-8000-000000000002",
  roleX: "90000000-0000-4000-8000-000000000001",
  roleY: "90000000-0000-4000-8000-000000000002",
  scopeA: "b0000000-0000-4000-8000-000000000001",
  scopeB: "b0000000-0000-4000-8000-000000000002",
  assignmentX: "b2000000-0000-4000-8000-000000000001",
  assignmentY: "b2000000-0000-4000-8000-000000000002",
  brandA: "20000000-0000-4000-8000-000000000001",
  brandB: "20000000-0000-4000-8000-000000000002",
  branchA: "30000000-0000-4000-8000-000000000001",
  branchB: "30000000-0000-4000-8000-000000000002",
  warehouseA: "40000000-0000-4000-8000-000000000001",
  warehouseB: "40000000-0000-4000-8000-000000000002",
  locationA: "50000000-0000-4000-8000-000000000001",
  locationB: "50000000-0000-4000-8000-000000000002",
  deviceActive: "c0000000-0000-4000-8000-000000000001",
  deviceRevoked: "c0000000-0000-4000-8000-000000000002",
} as const;

export const verifiedClerkIdentity: VerifiedExternalIdentity = {
  provider: "clerk",
  subject: "user_clerk_subject",
  sessionId: "sess_test",
};

export class FakeExternalIdentityVerifier implements ExternalIdentityVerifier {
  constructor(public identity: VerifiedExternalIdentity = verifiedClerkIdentity) {}

  async verifyRequest(): Promise<VerifiedExternalIdentity> {
    return this.identity;
  }
}

export function assignment(
  input: {
    id?: string;
    roleId?: string;
    scopeId?: string;
    permissionKeys?: readonly string[];
    targets?: readonly AuthorizationResource[];
    mode?: "tenant" | "explicit";
    roleStatus?: "active" | "archived";
    scopeStatus?: "active" | "archived";
    isProtected?: boolean;
    assignedAt?: string;
    unassignedAt?: string | null;
  } = {},
): AuthorizationAssignmentRecord {
  return {
    id: input.id ?? ids.assignmentX,
    tenantId: ids.tenantA,
    membershipId: ids.membershipA,
    assignedAt: input.assignedAt ?? "2026-08-01T00:00:00.000Z",
    unassignedAt: input.unassignedAt ?? null,
    role: {
      id: input.roleId ?? ids.roleX,
      tenantId: ids.tenantA,
      status: input.roleStatus ?? "active",
      isProtected: input.isProtected ?? false,
    },
    scope: {
      id: input.scopeId ?? ids.scopeA,
      tenantId: ids.tenantA,
      status: input.scopeStatus ?? "active",
      mode: input.mode ?? "tenant",
      targets: input.targets ?? [],
    },
    permissions: (input.permissionKeys ?? ["test.read"]).map((key) => ({
      key,
      status: "active" as const,
    })),
  };
}

export class FakeAuthorizationRepository implements AuthorizationStateRepository {
  bindings: ProviderBindingRecord[] = [
    {
      id: "71000000-0000-4000-8000-000000000001",
      userIdentityId: ids.user,
      provider: "clerk",
      providerSubject: verifiedClerkIdentity.subject,
      unlinkedAt: null,
    },
  ];

  identities: UserIdentityRecord[] = [{ id: ids.user, status: "active" }];
  tenants: TenantRecord[] = [
    { id: ids.tenantA, status: "active" },
    { id: ids.tenantB, status: "active" },
    { id: ids.tenantC, status: "active" },
  ];
  memberships: MembershipRecord[] = [
    {
      id: ids.membershipA,
      tenantId: ids.tenantA,
      userIdentityId: ids.user,
      status: "active",
    },
    {
      id: ids.membershipB,
      tenantId: ids.tenantB,
      userIdentityId: ids.user,
      status: "active",
    },
  ];
  devices: DeviceRecord[] = [
    { id: ids.deviceActive, tenantId: ids.tenantA, status: "active" },
    { id: ids.deviceRevoked, tenantId: ids.tenantA, status: "revoked" },
  ];
  assignmentsByMembership = new Map<string, AuthorizationAssignmentRecord[]>([
    [ids.membershipA, [assignment()]],
    [
      ids.membershipB,
      [
        {
          ...assignment(),
          tenantId: ids.tenantB,
          membershipId: ids.membershipB,
          role: { ...assignment().role, tenantId: ids.tenantB },
          scope: { ...assignment().scope, tenantId: ids.tenantB },
        },
      ],
    ],
  ]);
  resourceTenantIds = new Map<string, string[]>([
    [`brand:${ids.brandA}`, [ids.tenantA]],
    [`brand:${ids.brandB}`, [ids.tenantB]],
    [`branch:${ids.branchA}`, [ids.tenantA]],
    [`branch:${ids.branchB}`, [ids.tenantB]],
    [`warehouse:${ids.warehouseA}`, [ids.tenantA]],
    [`warehouse:${ids.warehouseB}`, [ids.tenantB]],
    [`inventory_location:${ids.locationA}`, [ids.tenantA]],
    [`inventory_location:${ids.locationB}`, [ids.tenantB]],
  ]);
  resourceLookupCount = 0;

  async findProviderBindings(provider: string, subject: string) {
    return this.bindings.filter(
      (binding) => binding.provider === provider && binding.providerSubject === subject,
    );
  }

  async findUserIdentities(id: string) {
    return this.identities.filter((identity) => identity.id === id);
  }

  async findTenants(id: string) {
    return this.tenants.filter((tenant) => tenant.id === id);
  }

  async findMemberships(tenantId: string, userIdentityId: string) {
    return this.memberships.filter(
      (membership) =>
        membership.tenantId === tenantId && membership.userIdentityId === userIdentityId,
    );
  }

  async loadAssignments(tenantId: string, membershipId: string) {
    return (this.assignmentsByMembership.get(membershipId) ?? []).filter(
      (currentAssignment) => currentAssignment.tenantId === tenantId,
    );
  }

  async findDevices(tenantId: string, deviceId: string) {
    return this.devices.filter((device) => device.tenantId === tenantId && device.id === deviceId);
  }

  async findResourceTenantIds(resource: AuthorizationResource) {
    this.resourceLookupCount += 1;
    return this.resourceTenantIds.get(`${resource.kind}:${resource.id}`) ?? [];
  }
}
