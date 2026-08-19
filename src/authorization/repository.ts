import type {
  AuthorizationAssignmentRecord,
  AuthorizationResource,
  DeviceRecord,
  MembershipRecord,
  ProviderBindingRecord,
  TenantRecord,
  UserIdentityRecord,
} from "./model";

/**
 * The only database surface allowed during authorization bootstrap. Implementations may use a
 * privileged credential, but must expose only current authorization state and resource ownership.
 */
export interface AuthorizationStateRepository {
  findProviderBindings(provider: string, providerSubject: string): Promise<ProviderBindingRecord[]>;
  findUserIdentities(id: string): Promise<UserIdentityRecord[]>;
  findTenants(id: string): Promise<TenantRecord[]>;
  findMemberships(tenantId: string, userIdentityId: string): Promise<MembershipRecord[]>;
  loadAssignments(tenantId: string, membershipId: string): Promise<AuthorizationAssignmentRecord[]>;
  findDevices(tenantId: string, deviceId: string): Promise<DeviceRecord[]>;
  findResourceTenantIds(resource: AuthorizationResource): Promise<string[]>;
}
