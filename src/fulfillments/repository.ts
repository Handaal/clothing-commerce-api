import type { AuthorizedOperationContext } from "../authorization";
import type { FulfillmentExecutionProof } from "./execution-proof";
import type {
  FulfillmentClientIntent,
  FulfillmentReplayPreflightResult,
  FulfillmentResult,
  FulfillmentRouting,
  OrderFulfillmentSummary,
  OrderRouting,
} from "./model";

/**
 * Internal, authorized command shape passed from the fulfillment service to the repository. tenantId and
 * actorMembershipId are derived from the verified authorization context; the resolved variant of each
 * line, the inventory operation, and all timestamps are derived by the database function. The repository
 * never accepts caller-controlled identity, variant, inventory delta, or fulfilled-quantity snapshot.
 */
export interface CreateFulfillmentCommand {
  readonly tenantId: string;
  readonly orderId: string;
  readonly inventoryLocationId: string;
  readonly actorMembershipId: string | null;
  readonly idempotencyKey: string;
  readonly lines: ReadonlyArray<{ readonly orderLineId: string; readonly quantity: number }>;
}

/**
 * Narrow, fulfillments-module-internal port that hides every persistence detail. It never exposes a
 * generic select/mutate, a raw client, SQL, or an RPC name.
 *
 * Three kinds of method exist:
 *   1. The single privileged MUTATION requires the composite FulfillmentExecutionProof (both authorities
 *      bound to the exact Order and InventoryLocation). A plain AuthorizedOperationProof -- even a
 *      genuine inventory.issue one -- cannot reach it.
 *   2. Commercial READS require an ordinary AuthorizedOperationProof (orders.read against the Order's
 *      commercial resource), a provenance deliberately distinct from the mutation proof.
 *   3. A small set of NARROW authorization-bootstrap lookups run BEFORE authorization, purely to resolve
 *      the resources an operation must be authorized against. They are tenant-constrained by a verified
 *      tenantId and return only routing metadata (never quantities, movement detail, or timestamps).
 */
export interface FulfillmentRepository {
  /**
   * BOOTSTRAP (no proof): the idempotency-replay preflight. Returns only routing metadata, and only on a
   * matching client-intent fingerprint; a conflict returns kind:"conflict" with no identifiers; a
   * missing/blank key or absent (tenant, key) returns kind:"none". Never exposes movement detail.
   */
  resolveReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: FulfillmentClientIntent,
  ): Promise<FulfillmentReplayPreflightResult>;

  /**
   * BOOTSTRAP (no proof): routing-only lookup of an Order's commercial routing within the verified
   * tenant, used to determine the brand/branch a NEW fulfillment must be authorized against.
   */
  getOrderRouting(tenantId: string, orderId: string): Promise<OrderRouting | null>;

  /**
   * BOOTSTRAP (no proof): routing-only lookup of a Fulfillment's Order commercial routing, used to
   * authorize a read before the aggregate is loaded.
   */
  getFulfillmentRouting(
    tenantId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentRouting | null>;

  /**
   * Mutation guarded by the COMPOSITE proof: sole atomic Fulfillment+lines+inventory-issue path. Returns
   * the new (or, on idempotent replay, the original) fulfillment and inventory-operation ids.
   */
  recordFulfillment(
    proof: FulfillmentExecutionProof,
    command: CreateFulfillmentCommand,
  ): Promise<{ readonly fulfillmentId: string; readonly inventoryOperationId: string }>;

  /** Proof-guarded read: load a full Fulfillment aggregate. Never called before authorization. */
  getFulfillment(
    proof: AuthorizedOperationContext,
    tenantId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentResult | null>;

  /** Proof-guarded read: load all Fulfillments of one Order. */
  getOrderFulfillments(
    proof: AuthorizedOperationContext,
    tenantId: string,
    orderId: string,
  ): Promise<readonly FulfillmentResult[]>;

  /**
   * Proof-guarded read: derive the per-order-line fulfillment progress summary from the OrderLines and
   * FulfillmentLines. Returns null when the Order does not exist. No persisted projection.
   */
  getOrderFulfillmentSummary(
    proof: AuthorizedOperationContext,
    tenantId: string,
    orderId: string,
  ): Promise<OrderFulfillmentSummary | null>;
}
