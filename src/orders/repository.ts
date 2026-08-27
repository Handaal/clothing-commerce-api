import type { AuthorizedOperationContext } from "../authorization";
import type {
  OrderClientIntent,
  OrderLineCatalogState,
  OrderResult,
  OrderRouting,
  RegisterContext,
  ReplayPreflightResult,
  ResolvedOrderLine,
} from "./model";

/**
 * Internal, authorized command shape passed from the order service to the repository. tenantId,
 * brandId, branchId, registerId, actorMembershipId, and the resolved line snapshots are already
 * derived from the verified authorization context, the resolved register, and the catalog; the
 * repository never accepts caller-controlled identity, brand, branch, price, or snapshot.
 */
export interface CreateOrderCommand {
  readonly tenantId: string;
  readonly channel: "pos" | "online";
  readonly currency: string;
  readonly brandId: string;
  readonly branchId: string | null;
  readonly registerId: string | null;
  readonly actorMembershipId: string | null;
  readonly idempotencyKey: string;
  readonly notes?: string;
  readonly lines: readonly ResolvedOrderLine[];
}

export interface CancelOrderCommand {
  readonly tenantId: string;
  readonly orderId: string;
  readonly cancelledByMembershipId: string;
  readonly reason?: string;
}

/**
 * Narrow, orders-module-internal port that hides every persistence detail. It never exposes a generic
 * select/mutate, a raw client, SQL, or an RPC name. Application code outside this module never receives
 * this repository.
 *
 * Two kinds of method exist:
 *   1. Commercial reads/mutations require the opaque authorization proof, so no privileged order data
 *      is read or written before authorization.
 *   2. A small set of NARROW authorization-bootstrap lookups run BEFORE authorization, purely to
 *      resolve the resource an operation must be authorized against. They are tenant-constrained by a
 *      verified tenantId, return only routing/foundational metadata (never lines, prices, totals,
 *      notes, or timestamps), and are individually documented below.
 */
export interface OrderRepository {
  /**
   * BOOTSTRAP (no proof): the idempotency-replay preflight. Returns only routing metadata, and only on
   * a matching client-intent fingerprint; a conflict returns kind:"conflict" with no identifiers; a
   * missing/blank key or absent (tenant, key) returns kind:"none". Never exposes commercial data.
   */
  resolveIdempotentReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: OrderClientIntent,
  ): Promise<ReplayPreflightResult>;

  /**
   * BOOTSTRAP (no proof): resolve a register's operational branch + status within the verified tenant,
   * used to determine the branch a POS create must be authorized against. Foundational config only.
   */
  getRegisterContext(tenantId: string, registerId: string): Promise<RegisterContext | null>;

  /**
   * BOOTSTRAP (no proof): derive the single Brand of the requested variants within the verified tenant,
   * used to determine the brand an ONLINE create must be authorized against. Returns null if a variant
   * is missing; throws only on a true multi-brand request (surfaced as CROSS_BRAND_ORDER by the caller).
   */
  deriveBrandForVariants(
    tenantId: string,
    variantIds: readonly string[],
  ): Promise<{ brandId: string } | { crossBrand: true } | null>;

  /**
   * BOOTSTRAP (no proof): routing-only lookup of an existing order by id, used to determine the
   * resource a read/cancel must be authorized against before the aggregate is loaded.
   */
  getOrderRouting(tenantId: string, orderId: string): Promise<OrderRouting | null>;

  /**
   * BOOTSTRAP (no proof): routing-only lookup of an existing order by normalized order number.
   */
  getOrderRoutingByNumber(
    tenantId: string,
    normalizedOrderNumber: string,
  ): Promise<OrderRouting | null>;

  /** Proof-guarded: branch lifecycle status within the tenant (NEW-command validation only). */
  getBranchStatus(
    proof: AuthorizedOperationContext,
    tenantId: string,
    branchId: string,
  ): Promise<"active" | "inactive" | "archived" | null>;

  /** Proof-guarded: whether the branch operates the brand (branch_brands eligibility). */
  isBrandCarriedByBranch(
    proof: AuthorizedOperationContext,
    tenantId: string,
    branchId: string,
    brandId: string,
  ): Promise<boolean>;

  /** Proof-guarded: resolve current catalog state for a variant (NEW-command validation/snapshots). */
  getOrderLineCatalogState(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
  ): Promise<OrderLineCatalogState | null>;

  /** Proof-guarded: resolve the single active price for a variant in a currency (minor units). */
  getActiveUnitPrice(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
    currency: string,
  ): Promise<number | null>;

  /** Proof-guarded: sole atomic order+lines creation path; returns the new order id. */
  createOrder(proof: AuthorizedOperationContext, command: CreateOrderCommand): Promise<string>;

  /** Proof-guarded: atomic write-once placed->cancelled transition. */
  cancelOrder(proof: AuthorizedOperationContext, command: CancelOrderCommand): Promise<void>;

  /** Proof-guarded: load the full order aggregate. Never called before authorization. */
  getOrder(
    proof: AuthorizedOperationContext,
    tenantId: string,
    orderId: string,
  ): Promise<OrderResult | null>;
}
