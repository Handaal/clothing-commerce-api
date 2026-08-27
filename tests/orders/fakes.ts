import { assertAuthorizedOperationProof } from "../../src/authorization";
import type { AuthorizationContext, AuthorizationResource } from "../../src/authorization";
import type { EffectiveAuthorizationAssignment } from "../../src/authorization/model";
import type { AuthorizationStateRepository } from "../../src/authorization/repository";
import { OrderError } from "../../src/orders/errors";
import type {
  OrderClientIntent,
  OrderLineCatalogState,
  OrderResult,
  OrderRouting,
  RegisterContext,
  ReplayPreflightResult,
  VariantStatus,
} from "../../src/orders/model";
import type {
  CancelOrderCommand,
  CreateOrderCommand,
  OrderRepository,
} from "../../src/orders/repository";

export const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  otherTenant: "10000000-0000-4000-8000-000000000002",
  membership: "80000000-0000-4000-8000-000000000001",
  otherMembership: "80000000-0000-4000-8000-000000000002",
  brand: "20000000-0000-4000-8000-000000000001",
  brandOther: "20000000-0000-4000-8000-000000000002",
  branch: "b0000000-0000-4000-8000-000000000001",
  branchOther: "b0000000-0000-4000-8000-000000000002",
  register: "c0000000-0000-4000-8000-000000000001",
  registerInactive: "c0000000-0000-4000-8000-000000000002",
  registerMissing: "c0000000-0000-4000-8000-0000000000ff",
  productA: "30000000-0000-4000-8000-000000000001",
  productOtherBrand: "30000000-0000-4000-8000-000000000002",
  variantA: "60000000-0000-4000-8000-000000000001",
  variantA2: "60000000-0000-4000-8000-000000000002",
  variantDraft: "60000000-0000-4000-8000-000000000003",
  variantOtherBrand: "60000000-0000-4000-8000-000000000004",
  variantMissing: "60000000-0000-4000-8000-0000000000ff",
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
    [`brand:${ids.brandOther}`, [ids.tenant]],
    [`branch:${ids.branch}`, [ids.tenant]],
    [`branch:${ids.branchOther}`, [ids.tenant]],
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

interface StoredVariant {
  productId: string;
  brandId: string;
  status: VariantStatus;
  productName: string;
  variantName: string | null;
  sku: string;
  optionSummary: string | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface StoredOrder extends Mutable<OrderResult> {
  tenantId: string;
  normalizedIdempotencyKey: string;
  fingerprint: string;
}

function fingerprintOf(intent: {
  channel: string;
  currency: string;
  registerId: string | null;
  lines: ReadonlyArray<{ variantId: string; quantity: number }>;
}): string {
  return JSON.stringify({
    channel: intent.channel,
    currency: intent.currency,
    registerId: intent.registerId,
    lines: intent.lines.map((line) => [line.variantId, line.quantity]),
  });
}

/**
 * In-memory order repository for service unit tests. It asserts the authorization proof on every
 * commercial read/mutation, mirrors the database's authoritative idempotency (matching intent replays,
 * differing intent conflicts), and returns deterministic results. Locking/atomicity/number-race
 * behaviour belongs to the persistence/concurrency suites, not here.
 */
export class FakeOrderRepository implements OrderRepository {
  registers = new Map<string, RegisterContext>();
  branchStatuses = new Map<string, "active" | "inactive" | "archived">();
  branchBrands = new Set<string>();
  variants = new Map<string, StoredVariant>();
  prices = new Map<string, number>();
  orders = new Map<string, StoredOrder>();
  calls: { method: string; command: unknown }[] = [];
  private seq = 0;

  seedDefaults(): this {
    this.registers.set(ids.register, { branchId: ids.branch, status: "active" });
    this.registers.set(ids.registerInactive, { branchId: ids.branch, status: "inactive" });
    this.branchStatuses.set(ids.branch, "active");
    this.branchStatuses.set(ids.branchOther, "active");
    this.branchBrands.add(`${ids.branch}:${ids.brand}`);
    this.variants.set(ids.variantA, {
      productId: ids.productA,
      brandId: ids.brand,
      status: "active",
      productName: "Classic Tee",
      variantName: "Classic Tee - M / Black",
      sku: "TEE-M-BLK",
      optionSummary: "Size: M / Color: Black",
    });
    this.variants.set(ids.variantA2, {
      productId: ids.productA,
      brandId: ids.brand,
      status: "active",
      productName: "Classic Tee",
      variantName: "Classic Tee - L / Black",
      sku: "TEE-L-BLK",
      optionSummary: "Size: L / Color: Black",
    });
    this.variants.set(ids.variantDraft, {
      productId: ids.productA,
      brandId: ids.brand,
      status: "draft",
      productName: "Classic Tee",
      variantName: null,
      sku: "TEE-DRAFT",
      optionSummary: null,
    });
    this.variants.set(ids.variantOtherBrand, {
      productId: ids.productOtherBrand,
      brandId: ids.brandOther,
      status: "active",
      productName: "Other Hoodie",
      variantName: null,
      sku: "HOOD-1",
      optionSummary: null,
    });
    this.prices.set(`${ids.variantA}:USD`, 2599);
    this.prices.set(`${ids.variantA2}:USD`, 3599);
    this.prices.set(`${ids.variantOtherBrand}:USD`, 4999);
    return this;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-0000-4000-8000-${this.seq.toString().padStart(12, "0")}`;
  }

  async resolveIdempotentReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: OrderClientIntent,
  ): Promise<ReplayPreflightResult> {
    const key = normalizedIdempotencyKey.trim().toLowerCase();
    if (key === "") {
      return { kind: "none" };
    }
    const fingerprint = fingerprintOf(intent);
    for (const order of this.orders.values()) {
      if (order.tenantId === tenantId && order.normalizedIdempotencyKey === key) {
        if (order.fingerprint === fingerprint) {
          return {
            kind: "replay",
            orderId: order.id,
            channel: order.channel,
            brandId: order.brandId,
            branchId: order.branchId,
          };
        }
        return { kind: "conflict" };
      }
    }
    return { kind: "none" };
  }

  async getRegisterContext(tenantId: string, registerId: string): Promise<RegisterContext | null> {
    if (tenantId !== ids.tenant) return null;
    return this.registers.get(registerId) ?? null;
  }

  async deriveBrandForVariants(
    tenantId: string,
    variantIds: readonly string[],
  ): Promise<{ brandId: string } | { crossBrand: true } | null> {
    if (tenantId !== ids.tenant) return null;
    const brandIds = new Set<string>();
    for (const variantId of variantIds) {
      const variant = this.variants.get(variantId);
      if (!variant) return null;
      brandIds.add(variant.brandId);
    }
    if (brandIds.size === 0) return null;
    if (brandIds.size > 1) return { crossBrand: true };
    return { brandId: [...brandIds][0] as string };
  }

  async getOrderRouting(tenantId: string, orderId: string): Promise<OrderRouting | null> {
    const order = this.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) return null;
    return {
      orderId: order.id,
      channel: order.channel,
      brandId: order.brandId,
      branchId: order.branchId,
    };
  }

  async getOrderRoutingByNumber(
    tenantId: string,
    normalizedOrderNumber: string,
  ): Promise<OrderRouting | null> {
    for (const order of this.orders.values()) {
      if (
        order.tenantId === tenantId &&
        order.orderNumber.trim().toLowerCase() === normalizedOrderNumber
      ) {
        return {
          orderId: order.id,
          channel: order.channel,
          brandId: order.brandId,
          branchId: order.branchId,
        };
      }
    }
    return null;
  }

  async getBranchStatus(
    proof: unknown,
    _tenantId: string,
    branchId: string,
  ): Promise<"active" | "inactive" | "archived" | null> {
    assertAuthorizedOperationProof(proof);
    return this.branchStatuses.get(branchId) ?? null;
  }

  async isBrandCarriedByBranch(
    proof: unknown,
    _tenantId: string,
    branchId: string,
    brandId: string,
  ): Promise<boolean> {
    assertAuthorizedOperationProof(proof);
    return this.branchBrands.has(`${branchId}:${brandId}`);
  }

  async getOrderLineCatalogState(
    proof: unknown,
    _tenantId: string,
    variantId: string,
  ): Promise<OrderLineCatalogState | null> {
    assertAuthorizedOperationProof(proof);
    const variant = this.variants.get(variantId);
    if (!variant) return null;
    return {
      variantId,
      productId: variant.productId,
      brandId: variant.brandId,
      variantStatus: variant.status,
      productName: variant.productName,
      variantName: variant.variantName,
      sku: variant.sku,
      optionSummary: variant.optionSummary,
    };
  }

  async getActiveUnitPrice(
    proof: unknown,
    _tenantId: string,
    variantId: string,
    currency: string,
  ): Promise<number | null> {
    assertAuthorizedOperationProof(proof);
    return this.prices.get(`${variantId}:${currency}`) ?? null;
  }

  async createOrder(proof: unknown, command: CreateOrderCommand): Promise<string> {
    assertAuthorizedOperationProof(proof);
    this.calls.push({ method: "createOrder", command });

    const normalizedKey = command.idempotencyKey.trim().toLowerCase();
    const fingerprint = fingerprintOf({
      channel: command.channel,
      currency: command.currency,
      registerId: command.registerId,
      lines: command.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
    });

    // Authoritative idempotency, mirroring create_order.
    for (const existing of this.orders.values()) {
      if (
        existing.tenantId === command.tenantId &&
        existing.normalizedIdempotencyKey === normalizedKey
      ) {
        if (existing.fingerprint !== fingerprint) {
          throw new OrderError("IDEMPOTENCY_CONFLICT");
        }
        return existing.id;
      }
    }

    let total = 0n;
    for (const line of command.lines) {
      total += BigInt(line.quantity) * BigInt(line.unitPriceMinor);
    }

    const id = this.nextId("d0000000");
    this.seq += 1;
    const orderNumber = this.seq.toString();
    const now = new Date().toISOString();
    const stored: StoredOrder = {
      tenantId: command.tenantId,
      normalizedIdempotencyKey: normalizedKey,
      fingerprint,
      id,
      orderNumber,
      channel: command.channel,
      status: "placed",
      brandId: command.brandId,
      branchId: command.branchId,
      registerId: command.registerId,
      currency: command.currency,
      totalMinor: Number(total),
      actorMembershipId: command.actorMembershipId,
      placedAt: now,
      cancelledAt: null,
      cancelledByMembershipId: null,
      cancellationReason: null,
      notes: command.notes ?? null,
      createdAt: now,
      updatedAt: now,
      lines: command.lines.map((line, index) => ({
        id: this.nextId("e0000000"),
        lineNumber: index + 1,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.quantity * line.unitPriceMinor,
        productName: line.productName,
        variantName: line.variantName,
        sku: line.sku,
        optionSummary: line.optionSummary,
      })),
    };
    this.orders.set(id, stored);
    return id;
  }

  async cancelOrder(proof: unknown, command: CancelOrderCommand): Promise<void> {
    assertAuthorizedOperationProof(proof);
    this.calls.push({ method: "cancelOrder", command });
    const order = this.orders.get(command.orderId);
    if (!order || order.tenantId !== command.tenantId) {
      throw new OrderError("ORDER_NOT_FOUND");
    }
    if (order.status === "placed") {
      const now = new Date().toISOString();
      order.status = "cancelled";
      order.cancelledAt = now;
      order.cancelledByMembershipId = command.cancelledByMembershipId;
      order.cancellationReason = command.reason ?? null;
      order.updatedAt = now;
    }
    // Already cancelled: write-once, never overwrite the original metadata.
  }

  async getOrder(proof: unknown, tenantId: string, orderId: string): Promise<OrderResult | null> {
    assertAuthorizedOperationProof(proof);
    const order = this.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) return null;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      channel: order.channel,
      status: order.status,
      brandId: order.brandId,
      branchId: order.branchId,
      registerId: order.registerId,
      currency: order.currency,
      totalMinor: order.totalMinor,
      actorMembershipId: order.actorMembershipId,
      placedAt: order.placedAt,
      cancelledAt: order.cancelledAt,
      cancelledByMembershipId: order.cancelledByMembershipId,
      cancellationReason: order.cancellationReason,
      notes: order.notes,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      lines: order.lines.map((line) => ({ ...line })),
    };
  }

  lastCreateCommand(): CreateOrderCommand {
    const call = [...this.calls].reverse().find((c) => c.method === "createOrder");
    if (!call) throw new Error("no createOrder call recorded");
    return call.command as CreateOrderCommand;
  }
}
