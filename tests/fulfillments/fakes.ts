import { assertAuthorizedOperationProof } from "../../src/authorization";
import type { AuthorizationContext, AuthorizationResource } from "../../src/authorization";
import type { EffectiveAuthorizationAssignment } from "../../src/authorization/model";
import type { AuthorizationStateRepository } from "../../src/authorization/repository";
import { assertFulfillmentExecutionProof } from "../../src/fulfillments";
import { FulfillmentError } from "../../src/fulfillments/errors";
import type {
  FulfillmentClientIntent,
  FulfillmentReplayPreflightResult,
  FulfillmentResult,
  FulfillmentRouting,
  OrderChannel,
  OrderFulfillmentSummary,
  OrderRouting,
} from "../../src/fulfillments/model";
import type {
  CreateFulfillmentCommand,
  FulfillmentRepository,
} from "../../src/fulfillments/repository";

export const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  otherTenant: "10000000-0000-4000-8000-000000000002",
  membership: "80000000-0000-4000-8000-000000000001",
  brand: "20000000-0000-4000-8000-000000000001",
  branch: "b0000000-0000-4000-8000-000000000001",
  orderOnline: "d0000000-0000-4000-8000-000000000001",
  orderPos: "d0000000-0000-4000-8000-000000000002",
  orderLine1: "e0000000-0000-4000-8000-000000000001",
  orderLine2: "e0000000-0000-4000-8000-000000000002",
  orderLinePos: "e0000000-0000-4000-8000-000000000003",
  variant1: "60000000-0000-4000-8000-000000000001",
  variant2: "60000000-0000-4000-8000-000000000002",
  location: "f0000000-0000-4000-8000-000000000001",
  locationOther: "f0000000-0000-4000-8000-000000000002",
  missingOrder: "d0000000-0000-4000-8000-0000000000ff",
  missingFulfillment: "a0000000-0000-4000-8000-0000000000ff",
} as const;

type ResourceTenantMap = Map<string, string[]>;

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
    [`brand:${ids.brand}`, [ids.tenant]],
    [`branch:${ids.branch}`, [ids.tenant]],
    [`inventory_location:${ids.location}`, [ids.tenant]],
    [`inventory_location:${ids.locationOther}`, [ids.tenant]],
  ]);
}

export function grant(
  permissionKeys: readonly string[],
  targets?: readonly AuthorizationResource[],
  overrides: Partial<EffectiveAuthorizationAssignment> = {},
): EffectiveAuthorizationAssignment {
  return {
    assignmentId: overrides.assignmentId ?? "a2000000-0000-4000-8000-000000000001",
    roleId: "90000000-0000-4000-8000-000000000001",
    isProtectedRole: false,
    accessScopeId: "a1000000-0000-4000-8000-000000000001",
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

export function brand(id: string): AuthorizationResource {
  return { kind: "brand", id };
}
export function branch(id: string): AuthorizationResource {
  return { kind: "branch", id };
}
export function location(id: string): AuthorizationResource {
  return { kind: "inventory_location", id };
}

interface StoredOrder {
  tenantId: string;
  channel: OrderChannel;
  brandId: string;
  branchId: string | null;
  lines: Map<string, { variantId: string; quantity: number }>;
}

interface StoredFulfillmentLine {
  id: string;
  lineNumber: number;
  orderLineId: string;
  variantId: string;
  quantity: number;
}

interface StoredFulfillment {
  id: string;
  tenantId: string;
  orderId: string;
  inventoryLocationId: string;
  inventoryOperationId: string;
  actorMembershipId: string | null;
  normalizedKey: string;
  fingerprint: string;
  fulfilledAt: string;
  createdAt: string;
  lines: StoredFulfillmentLine[];
}

function fingerprintOf(intent: {
  orderId: string;
  inventoryLocationId: string;
  lines: ReadonlyArray<{ orderLineId: string; quantity: number }>;
}): string {
  return JSON.stringify({
    orderId: intent.orderId,
    inventoryLocationId: intent.inventoryLocationId,
    lines: intent.lines.map((line) => [line.orderLineId, line.quantity]),
  });
}

/**
 * In-memory fulfillment repository for service unit tests. It asserts the COMPOSITE proof on the
 * mutation and an ordinary AuthorizedOperationProof on reads, mirrors the database's authoritative
 * idempotency (matching intent replays, differing intent conflicts), and records method calls so a test
 * can assert, e.g., that replay never re-resolves routing. Locking/atomicity/over-fulfillment belong to
 * the persistence/concurrency suites.
 */
export class FakeFulfillmentRepository implements FulfillmentRepository {
  orders = new Map<string, StoredOrder>();
  fulfillments = new Map<string, StoredFulfillment>();
  calls: string[] = [];
  private seq = 0;

  seedDefaults(): this {
    this.orders.set(ids.orderOnline, {
      tenantId: ids.tenant,
      channel: "online",
      brandId: ids.brand,
      branchId: null,
      lines: new Map([
        [ids.orderLine1, { variantId: ids.variant1, quantity: 5 }],
        [ids.orderLine2, { variantId: ids.variant2, quantity: 3 }],
      ]),
    });
    this.orders.set(ids.orderPos, {
      tenantId: ids.tenant,
      channel: "pos",
      brandId: ids.brand,
      branchId: ids.branch,
      lines: new Map([[ids.orderLinePos, { variantId: ids.variant1, quantity: 4 }]]),
    });
    return this;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-0000-4000-8000-${this.seq.toString().padStart(12, "0")}`;
  }

  async resolveReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: FulfillmentClientIntent,
  ): Promise<FulfillmentReplayPreflightResult> {
    this.calls.push("resolveReplayTarget");
    const key = normalizedIdempotencyKey.trim().toLowerCase();
    if (key === "") {
      return { kind: "none" };
    }
    const fingerprint = fingerprintOf(intent);
    for (const fulfillment of this.fulfillments.values()) {
      if (fulfillment.tenantId === tenantId && fulfillment.normalizedKey === key) {
        if (fulfillment.fingerprint !== fingerprint) {
          return { kind: "conflict" };
        }
        const order = this.orders.get(fulfillment.orderId);
        if (!order) {
          return { kind: "none" };
        }
        return {
          kind: "replay",
          fulfillmentId: fulfillment.id,
          orderId: fulfillment.orderId,
          inventoryLocationId: fulfillment.inventoryLocationId,
          channel: order.channel,
          brandId: order.brandId,
          branchId: order.branchId,
        };
      }
    }
    return { kind: "none" };
  }

  async getOrderRouting(tenantId: string, orderId: string): Promise<OrderRouting | null> {
    this.calls.push("getOrderRouting");
    const order = this.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) {
      return null;
    }
    return { orderId, channel: order.channel, brandId: order.brandId, branchId: order.branchId };
  }

  async getFulfillmentRouting(
    tenantId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentRouting | null> {
    this.calls.push("getFulfillmentRouting");
    const fulfillment = this.fulfillments.get(fulfillmentId);
    if (!fulfillment || fulfillment.tenantId !== tenantId) {
      return null;
    }
    const order = this.orders.get(fulfillment.orderId);
    if (!order) {
      return null;
    }
    return {
      fulfillmentId,
      orderId: fulfillment.orderId,
      channel: order.channel,
      brandId: order.brandId,
      branchId: order.branchId,
    };
  }

  async recordFulfillment(
    proof: unknown,
    command: CreateFulfillmentCommand,
  ): Promise<{ readonly fulfillmentId: string; readonly inventoryOperationId: string }> {
    // The mutation boundary requires the composite proof, never a plain AuthorizedOperationProof.
    assertFulfillmentExecutionProof(proof);
    this.calls.push("recordFulfillment");

    const normalizedKey = command.idempotencyKey.trim().toLowerCase();
    const fingerprint = fingerprintOf({
      orderId: command.orderId,
      inventoryLocationId: command.inventoryLocationId,
      lines: command.lines,
    });

    for (const existing of this.fulfillments.values()) {
      if (existing.tenantId === command.tenantId && existing.normalizedKey === normalizedKey) {
        if (existing.fingerprint !== fingerprint) {
          throw new FulfillmentError("IDEMPOTENCY_CONFLICT");
        }
        return {
          fulfillmentId: existing.id,
          inventoryOperationId: existing.inventoryOperationId,
        };
      }
    }

    const order = this.orders.get(command.orderId);
    if (!order || order.tenantId !== command.tenantId) {
      throw new FulfillmentError("ORDER_NOT_FOUND");
    }

    const id = this.nextId("a0000000");
    const operationId = this.nextId("c0000000");
    const now = new Date().toISOString();
    const lines: StoredFulfillmentLine[] = command.lines.map((line, index) => {
      const orderLine = order.lines.get(line.orderLineId);
      if (!orderLine) {
        throw new FulfillmentError("ORDER_LINE_NOT_FOUND");
      }
      return {
        id: this.nextId("b0000000"),
        lineNumber: index + 1,
        orderLineId: line.orderLineId,
        variantId: orderLine.variantId,
        quantity: line.quantity,
      };
    });

    this.fulfillments.set(id, {
      id,
      tenantId: command.tenantId,
      orderId: command.orderId,
      inventoryLocationId: command.inventoryLocationId,
      inventoryOperationId: operationId,
      actorMembershipId: command.actorMembershipId,
      normalizedKey,
      fingerprint,
      fulfilledAt: now,
      createdAt: now,
      lines,
    });
    return { fulfillmentId: id, inventoryOperationId: operationId };
  }

  async getFulfillment(
    proof: unknown,
    tenantId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentResult | null> {
    assertAuthorizedOperationProof(proof);
    this.calls.push("getFulfillment");
    const fulfillment = this.fulfillments.get(fulfillmentId);
    if (!fulfillment || fulfillment.tenantId !== tenantId) {
      return null;
    }
    return this.toResult(fulfillment);
  }

  async getOrderFulfillments(
    proof: unknown,
    tenantId: string,
    orderId: string,
  ): Promise<readonly FulfillmentResult[]> {
    assertAuthorizedOperationProof(proof);
    this.calls.push("getOrderFulfillments");
    return [...this.fulfillments.values()]
      .filter((fulfillment) => fulfillment.tenantId === tenantId && fulfillment.orderId === orderId)
      .map((fulfillment) => this.toResult(fulfillment));
  }

  async getOrderFulfillmentSummary(
    proof: unknown,
    tenantId: string,
    orderId: string,
  ): Promise<OrderFulfillmentSummary | null> {
    assertAuthorizedOperationProof(proof);
    this.calls.push("getOrderFulfillmentSummary");
    const order = this.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) {
      return null;
    }
    const fulfilledByLine = new Map<string, number>();
    const fulfillmentIds = new Set<string>();
    for (const fulfillment of this.fulfillments.values()) {
      if (fulfillment.tenantId !== tenantId || fulfillment.orderId !== orderId) {
        continue;
      }
      fulfillmentIds.add(fulfillment.id);
      for (const line of fulfillment.lines) {
        fulfilledByLine.set(
          line.orderLineId,
          (fulfilledByLine.get(line.orderLineId) ?? 0) + line.quantity,
        );
      }
    }
    const lines = [...order.lines.entries()].map(([orderLineId, orderLine]) => {
      const fulfilled = fulfilledByLine.get(orderLineId) ?? 0;
      return {
        orderLineId,
        variantId: orderLine.variantId,
        orderedQuantity: orderLine.quantity,
        fulfilledQuantity: fulfilled,
        status: progress(fulfilled, orderLine.quantity),
      };
    });
    const totalOrdered = lines.reduce((sum, line) => sum + line.orderedQuantity, 0);
    const totalFulfilled = lines.reduce((sum, line) => sum + line.fulfilledQuantity, 0);
    return {
      orderId,
      status: progress(totalFulfilled, totalOrdered),
      lines,
      fulfillmentIds: [...fulfillmentIds],
    };
  }

  private toResult(fulfillment: StoredFulfillment): FulfillmentResult {
    return {
      id: fulfillment.id,
      orderId: fulfillment.orderId,
      inventoryLocationId: fulfillment.inventoryLocationId,
      inventoryOperationId: fulfillment.inventoryOperationId,
      actorMembershipId: fulfillment.actorMembershipId,
      fulfilledAt: fulfillment.fulfilledAt,
      createdAt: fulfillment.createdAt,
      lines: fulfillment.lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        orderLineId: line.orderLineId,
        variantId: line.variantId,
        quantity: line.quantity,
      })),
    };
  }
}

function progress(
  fulfilled: number,
  ordered: number,
): "unfulfilled" | "partially_fulfilled" | "fulfilled" {
  if (fulfilled <= 0) {
    return "unfulfilled";
  }
  if (fulfilled >= ordered) {
    return "fulfilled";
  }
  return "partially_fulfilled";
}
