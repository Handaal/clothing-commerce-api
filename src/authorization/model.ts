import { z } from "zod";

export const TenantSelectionSchema = z.string().uuid();

export const PermissionKeySchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export const AuthorizationResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brand"), id: z.string().uuid() }),
  z.object({ kind: z.literal("branch"), id: z.string().uuid() }),
  z.object({ kind: z.literal("warehouse"), id: z.string().uuid() }),
  z.object({ kind: z.literal("inventory_location"), id: z.string().uuid() }),
]);

export type AuthorizationResource = z.infer<typeof AuthorizationResourceSchema>;
export type AuthorizationResourceKind = AuthorizationResource["kind"];

export interface VerifiedExternalIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly sessionId?: string;
}

export interface VerifiedDeviceIdentity {
  readonly deviceId: string;
  readonly credentialId?: string;
}

export interface ProviderBindingRecord {
  readonly id: string;
  readonly userIdentityId: string;
  readonly provider: string;
  readonly providerSubject: string;
  readonly unlinkedAt: string | null;
}

export interface UserIdentityRecord {
  readonly id: string;
  readonly status: "active" | "suspended" | "deactivated";
}

export interface TenantRecord {
  readonly id: string;
  readonly status: "provisioning" | "active" | "suspended" | "archived";
}

export interface MembershipRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userIdentityId: string;
  readonly status: "invited" | "active" | "suspended" | "deactivated";
}

export interface DeviceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: "enrolled" | "active" | "revoked";
}

export interface AssignmentPermissionRecord {
  readonly key: string;
  readonly status: "active" | "deprecated";
}

export interface AssignmentRoleRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: "active" | "archived";
  readonly isProtected: boolean;
}

export interface AssignmentScopeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: "active" | "archived";
  readonly mode: "tenant" | "explicit";
  readonly targets: readonly AuthorizationResource[];
}

export interface AuthorizationAssignmentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly assignedAt: string;
  readonly unassignedAt: string | null;
  readonly role: AssignmentRoleRecord;
  readonly scope: AssignmentScopeRecord;
  readonly permissions: readonly AssignmentPermissionRecord[];
}

export interface EffectiveAuthorizationAssignment {
  readonly assignmentId: string;
  readonly roleId: string;
  readonly isProtectedRole: boolean;
  readonly accessScopeId: string;
  readonly scopeMode: "tenant" | "explicit";
  readonly scopeTargets: readonly AuthorizationResource[];
  readonly permissionKeys: readonly string[];
}

export interface AuthorizationContext {
  readonly authentication: {
    readonly provider: string;
    readonly subject: string;
    readonly sessionId?: string;
  };
  readonly userIdentity: {
    readonly id: string;
  };
  readonly tenant: {
    readonly id: string;
  };
  readonly membership: {
    readonly id: string;
  };
  readonly assignments: readonly EffectiveAuthorizationAssignment[];
  readonly device?: {
    readonly id: string;
  };
}

export interface AuthorizationRequest {
  readonly permissionKey: string;
  readonly resources?: readonly AuthorizationResource[];
}
