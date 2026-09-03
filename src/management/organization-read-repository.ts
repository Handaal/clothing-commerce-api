/**
 * Read-only organization metadata used to (a) resolve the tenant summary for /me/context and (b) hydrate
 * the display names of resources a caller's already-derived visibility grants. Every method is
 * tenant-filtered. This is NOT a generic organization-enumeration surface: hydration is only ever called
 * with the exact ids a visibility derivation produced (or "all" within the tenant when the grant is
 * tenant-wide).
 */

export interface OrgTenantSummary {
  readonly id: string;
  readonly name: string;
  readonly status: "provisioning" | "active" | "suspended" | "archived";
}

export interface OrgBrand {
  readonly id: string;
  readonly name: string;
}

export interface OrgBranch {
  readonly id: string;
  readonly name: string;
}

export interface OrgInventoryLocation {
  readonly id: string;
  readonly name: string;
  readonly branchId: string | null;
}

/**
 * A candidate write-target location with the operational facts /me/context needs to derive
 * write capability: lifecycle status plus the three per-operation capability flags. This is the
 * SAME data the mutation path reads before authorizing an operation; exposing it in read-only context
 * is UX guidance and never a substitute for the server-side check the POST routes perform.
 */
export interface OrgInventoryLocationCapability {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "inactive" | "archived";
  readonly isReceivingEnabled: boolean;
  readonly isTransferOriginEnabled: boolean;
  readonly isTransferDestinationEnabled: boolean;
}

/**
 * A hydration selector. `null` means "all rows within the tenant" (used for tenant-wide grants); an
 * array means exactly those ids within the tenant (used for explicit grants). An empty array resolves to
 * an empty result without a database round-trip.
 */
export type IdSelector = readonly string[] | null;

export interface OrganizationReadRepository {
  findTenantSummary(tenantId: string): Promise<OrgTenantSummary | null>;
  findBrands(tenantId: string, selector: IdSelector): Promise<OrgBrand[]>;
  findBranches(tenantId: string, selector: IdSelector): Promise<OrgBranch[]>;
  findInventoryLocations(tenantId: string, selector: IdSelector): Promise<OrgInventoryLocation[]>;
  findInventoryLocationCapabilities(
    tenantId: string,
    selector: IdSelector,
  ): Promise<OrgInventoryLocationCapability[]>;
}
