import type { ExternalIdentityVerifier } from "../authentication/external-identity";
import { AuthorizationError } from "../authorization/errors";
import type { ProviderBindingRecord, UserIdentityRecord } from "../authorization/model";
import type { MeTenant } from "../contracts";

/**
 * Identity-scoped membership record (never tenant-filtered by a caller value). It is loaded strictly by
 * the verified identity's own id.
 */
export interface IdentityMembershipRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: "invited" | "active" | "suspended" | "deactivated";
}

export interface TenantSummaryRecord {
  readonly id: string;
  readonly name: string;
  readonly status: "provisioning" | "active" | "suspended" | "archived";
}

/**
 * The narrow database surface for the identity bootstrap. It intentionally has no method that accepts a
 * caller-supplied identity id, no "find all memberships", and no search: membership lookup is bound to
 * the id of the identity the request's own verified provider binding resolves to.
 */
export interface IdentityMembershipRepository {
  findProviderBindings(provider: string, providerSubject: string): Promise<ProviderBindingRecord[]>;
  findUserIdentities(id: string): Promise<UserIdentityRecord[]>;
  /** Memberships belonging ONLY to this identity. The id is derived, never caller-supplied. */
  findMembershipsForIdentity(identityId: string): Promise<IdentityMembershipRecord[]>;
  /** Active tenant summaries for the given ids; non-active tenants are omitted. */
  findActiveTenantSummaries(tenantIds: readonly string[]): Promise<TenantSummaryRecord[]>;
}

/**
 * Resolves the verified caller's own selectable tenants for GET /api/v1/me/tenants. This is a deliberate,
 * minimal bootstrap boundary distinct from the full AuthorizationContextResolver: it authenticates the
 * identity WITHOUT any tenant context and returns only that identity's active memberships against active
 * tenants. It never reads another identity's data and never accepts a tenant header.
 */
export class IdentityMembershipResolver {
  constructor(
    private readonly identityVerifier: ExternalIdentityVerifier,
    private readonly repository: IdentityMembershipRepository,
  ) {}

  async resolve(request: Request): Promise<MeTenant[]> {
    const externalIdentity = await this.identityVerifier.verifyRequest(request);

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

    const memberships = await this.repository.findMembershipsForIdentity(identity.id);
    const activeMemberships = memberships.filter((membership) => membership.status === "active");
    if (activeMemberships.length === 0) {
      return [];
    }

    const tenantIds = [...new Set(activeMemberships.map((membership) => membership.tenantId))];
    const tenantSummaries = await this.repository.findActiveTenantSummaries(tenantIds);
    const tenantById = new Map(tenantSummaries.map((tenant) => [tenant.id, tenant]));

    const rows: MeTenant[] = [];
    for (const membership of activeMemberships) {
      const tenant = tenantById.get(membership.tenantId);
      // Only active tenants are selectable; a membership against a suspended/archived/provisioning
      // tenant is silently excluded rather than surfaced.
      if (tenant === undefined || tenant.status !== "active") {
        continue;
      }
      rows.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        membershipId: membership.id,
      });
    }

    // Deterministic ordering for stable clients and tests.
    rows.sort((left, right) =>
      left.tenantName === right.tenantName
        ? left.tenantId.localeCompare(right.tenantId)
        : left.tenantName.localeCompare(right.tenantName),
    );
    return rows;
  }
}
