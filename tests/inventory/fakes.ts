import { assertAuthorizedOperationProof } from "../../src/authorization";
import type { AuthorizationContext, AuthorizationResource } from "../../src/authorization";
import type { EffectiveAuthorizationAssignment } from "../../src/authorization/model";
import type { AuthorizationStateRepository } from "../../src/authorization/repository";
import type {
  InventoryBalanceResult,
  InventoryLocationState,
  InventoryMutationResult,
  InventoryObservedMutationResult,
  InventoryTransferResult,
  StockKey,
  VariantState,
} from "../../src/inventory/model";
import type {
  InventoryRepository,
  RecordCountAdjustmentCommand,
  RecordIssueCommand,
  RecordOpeningCommand,
  RecordReceiptCommand,
  RecordTransferCommand,
} from "../../src/inventory/repository";

export const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  otherTenant: "10000000-0000-4000-8000-000000000002",
  membership: "80000000-0000-4000-8000-000000000001",
  variantActive: "60000000-0000-4000-8000-000000000001",
  variantDraft: "60000000-0000-4000-8000-000000000002",
  variantArchived: "60000000-0000-4000-8000-000000000003",
  variantMissing: "60000000-0000-4000-8000-0000000000ff",
  locationActive: "50000000-0000-4000-8000-000000000001",
  locationDestination: "50000000-0000-4000-8000-000000000002",
  locationInactive: "50000000-0000-4000-8000-000000000003",
  locationArchived: "50000000-0000-4000-8000-000000000004",
  locationForeign: "50000000-0000-4000-8000-0000000000fe",
  locationMissing: "50000000-0000-4000-8000-0000000000ff",
} as const;

type ResourceTenantMap = Map<string, string[]>;

/** Minimal authorization state repository: only resource-tenant lookup is exercised by authorize(). */
export class StubResourceRepository implements AuthorizationStateRepository {
  constructor(private readonly tenantByResource: ResourceTenantMap) {}

  async findResourceTenantIds(resource: AuthorizationResource): Promise<string[]> {
    return this.tenantByResource.get(`${resource.kind}:${resource.id}`) ?? [];
  }

  async findProviderBindings(): Promise<never[]> {
    throw new Error("unused");
  }
  async findUserIdentities(): Promise<never[]> {
    throw new Error("unused");
  }
  async findTenants(): Promise<never[]> {
    throw new Error("unused");
  }
  async findMemberships(): Promise<never[]> {
    throw new Error("unused");
  }
  async loadAssignments(): Promise<never[]> {
    throw new Error("unused");
  }
  async findDevices(): Promise<never[]> {
    throw new Error("unused");
  }
}

export function defaultResourceTenantMap(): ResourceTenantMap {
  return new Map<string, string[]>([
    [`inventory_location:${ids.locationActive}`, [ids.tenant]],
    [`inventory_location:${ids.locationDestination}`, [ids.tenant]],
    [`inventory_location:${ids.locationInactive}`, [ids.tenant]],
    [`inventory_location:${ids.locationArchived}`, [ids.tenant]],
    // A location that belongs to another tenant; authorize() must reject it as cross-tenant.
    [`inventory_location:${ids.locationForeign}`, [ids.otherTenant]],
  ]);
}

export function grant(
  permissionKeys: readonly string[],
  targets?: readonly AuthorizationResource[],
  overrides: Partial<EffectiveAuthorizationAssignment> = {},
): EffectiveAuthorizationAssignment {
  return {
    assignmentId: overrides.assignmentId ?? "b2000000-0000-4000-8000-000000000001",
    roleId: "90000000-0000-4000-8000-000000000001",
    isProtectedRole: false,
    accessScopeId: "b0000000-0000-4000-8000-000000000001",
    scopeMode: targets ? "explicit" : "tenant",
    scopeTargets: targets ?? [],
    permissionKeys,
    ...overrides,
  };
}

export function contextWith(
  assignments: readonly EffectiveAuthorizationAssignment[],
  overrides: { tenantId?: string; membershipId?: string } = {},
): AuthorizationContext {
  return {
    authentication: { provider: "clerk", subject: "user_subject" },
    userIdentity: { id: "70000000-0000-4000-8000-000000000001" },
    tenant: { id: overrides.tenantId ?? ids.tenant },
    membership: { id: overrides.membershipId ?? ids.membership },
    assignments,
  };
}

export function location(id: string): AuthorizationResource {
  return { kind: "inventory_location", id };
}

interface RecordedCall {
  readonly method: string;
  readonly command: unknown;
}

/**
 * In-memory inventory repository for service unit tests. It asserts the authorization proof (proving
 * the service authorized before privileged access), records forwarded commands, and returns
 * deterministic results. Database invariants (locking, negative-stock, idempotency fingerprints) are
 * intentionally not simulated here; those belong to the persistence/concurrency suites.
 */
export class FakeInventoryRepository implements InventoryRepository {
  variantStates = new Map<string, VariantState>();
  locationStates = new Map<string, InventoryLocationState>();
  balances = new Map<string, { onHand: number; version: number }>();
  calls: RecordedCall[] = [];
  failWith: Error | null = null;
  private opSeq = 0;

  seedDefaults(): this {
    this.variantStates.set(ids.variantActive, { status: "active" });
    this.variantStates.set(ids.variantDraft, { status: "draft" });
    this.variantStates.set(ids.variantArchived, { status: "archived" });
    this.locationStates.set(ids.locationActive, activeLocation());
    this.locationStates.set(ids.locationDestination, activeLocation());
    this.locationStates.set(ids.locationInactive, { ...activeLocation(), status: "inactive" });
    this.locationStates.set(ids.locationArchived, { ...activeLocation(), status: "archived" });
    return this;
  }

  private key(k: StockKey): string {
    return `${k.variantId}:${k.inventoryLocationId}`;
  }

  private nextOperationId(): string {
    this.opSeq += 1;
    return `a0000000-0000-4000-8000-${this.opSeq.toString().padStart(12, "0")}`;
  }

  async getBalance(proof: unknown, key: StockKey): Promise<InventoryBalanceResult> {
    assertAuthorizedOperationProof(proof);
    const balance = this.balances.get(this.key(key));
    return {
      variantId: key.variantId,
      inventoryLocationId: key.inventoryLocationId,
      onHand: balance?.onHand ?? 0,
      version: balance?.version ?? 0,
      exists: balance !== undefined,
    };
  }

  async getVariantState(
    proof: unknown,
    _tenantId: string,
    variantId: string,
  ): Promise<VariantState | null> {
    assertAuthorizedOperationProof(proof);
    return this.variantStates.get(variantId) ?? null;
  }

  async getLocationState(
    proof: unknown,
    _tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryLocationState | null> {
    assertAuthorizedOperationProof(proof);
    return this.locationStates.get(inventoryLocationId) ?? null;
  }

  async recordOpening(
    proof: unknown,
    command: RecordOpeningCommand,
  ): Promise<InventoryMutationResult> {
    assertAuthorizedOperationProof(proof);
    this.calls.push({ method: "recordOpening", command });
    if (this.failWith) throw this.failWith;
    return {
      operationId: this.nextOperationId(),
      changed: true,
      variantId: command.variantId,
      inventoryLocationId: command.inventoryLocationId,
      previousOnHand: 0,
      newOnHand: command.quantity,
      version: 1,
    };
  }

  async recordCountAdjustment(
    proof: unknown,
    command: RecordCountAdjustmentCommand,
  ): Promise<InventoryMutationResult> {
    assertAuthorizedOperationProof(proof);
    this.calls.push({ method: "recordCountAdjustment", command });
    if (this.failWith) throw this.failWith;
    const current = this.balances.get(this.key(command)) ?? { onHand: 0, version: 0 };
    const changed = command.countedQuantity !== current.onHand;
    // A no-op count still persists a durable operation envelope, so operationId is always present.
    return {
      operationId: this.nextOperationId(),
      changed,
      variantId: command.variantId,
      inventoryLocationId: command.inventoryLocationId,
      previousOnHand: current.onHand,
      newOnHand: command.countedQuantity,
      version: changed ? current.version + 1 : current.version,
    };
  }

  async recordReceipt(
    proof: unknown,
    command: RecordReceiptCommand,
  ): Promise<InventoryObservedMutationResult> {
    assertAuthorizedOperationProof(proof);
    this.calls.push({ method: "recordReceipt", command });
    if (this.failWith) throw this.failWith;
    return {
      operationId: this.nextOperationId(),
      changed: true,
      variantId: command.variantId,
      inventoryLocationId: command.inventoryLocationId,
      observedOnHand: command.quantity,
      observedVersion: 1,
    };
  }

  async recordIssue(
    proof: unknown,
    command: RecordIssueCommand,
  ): Promise<InventoryObservedMutationResult> {
    assertAuthorizedOperationProof(proof);
    this.calls.push({ method: "recordIssue", command });
    if (this.failWith) throw this.failWith;
    return {
      operationId: this.nextOperationId(),
      changed: true,
      variantId: command.variantId,
      inventoryLocationId: command.inventoryLocationId,
      observedOnHand: 0,
      observedVersion: 1,
    };
  }

  async recordTransfer(
    proof: unknown,
    command: RecordTransferCommand,
  ): Promise<InventoryTransferResult> {
    assertAuthorizedOperationProof(proof);
    this.calls.push({ method: "recordTransfer", command });
    if (this.failWith) throw this.failWith;
    return {
      operationId: this.nextOperationId(),
      variantId: command.variantId,
      source: {
        inventoryLocationId: command.sourceInventoryLocationId,
        observedOnHand: 0,
        observedVersion: 1,
      },
      destination: {
        inventoryLocationId: command.destinationInventoryLocationId,
        observedOnHand: command.quantity,
        observedVersion: 1,
      },
    };
  }

  lastCall(): RecordedCall {
    const call = this.calls.at(-1);
    if (!call) {
      throw new Error("no repository call was recorded");
    }
    return call;
  }
}

export function activeLocation(): InventoryLocationState {
  return {
    status: "active",
    isReceivingEnabled: true,
    isTransferOriginEnabled: true,
    isTransferDestinationEnabled: true,
  };
}
