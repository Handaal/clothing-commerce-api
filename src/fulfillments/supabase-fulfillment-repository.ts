import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import { assertFulfillmentExecutionProof, type FulfillmentExecutionProof } from "./execution-proof";
import { FulfillmentError } from "./errors";
import type {
  FulfillmentClientIntent,
  FulfillmentReplayPreflightResult,
  FulfillmentResult,
  FulfillmentRouting,
  OrderFulfillmentLineSummary,
  OrderFulfillmentSummary,
  OrderRouting,
  FulfillmentProgressStatus,
} from "./model";
import type { CreateFulfillmentCommand, FulfillmentRepository } from "./repository";

// The private schema that owns the sanctioned functions. It is exposed to PostgREST so the service-role
// client can call the functions by name; execution is gated by the EXECUTE grants (service_role only),
// never by schema exposure.
const FULFILLMENTS_PRIVATE_SCHEMA = "fulfillments_private";

// A bigint column/return that must round-trip through JSON without precision loss. PostgREST may hand
// back int8 as a number or a string. The Phase 2E application contract carries quantities as JS safe
// integers while the database stays bigint; a value outside that range is a numeric transport/invariant
// failure, NOT a business condition, and surfaces as a generic internal error.
function toSafeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error("A fulfillment quantity is outside the supported application range.");
  }
  return parsed;
}

const ReplayRowSchema = z.object({
  fingerprint_matches: z.boolean(),
  fulfillment_id: z.string().uuid().nullable(),
  order_id: z.string().uuid().nullable(),
  inventory_location_id: z.string().uuid().nullable(),
  channel: z.enum(["pos", "online"]).nullable(),
  brand_id: z.string().uuid().nullable(),
  branch_id: z.string().uuid().nullable(),
});

const OrderRoutingRowSchema = z.object({
  id: z.string().uuid(),
  channel: z.enum(["pos", "online"]),
  brand_id: z.string().uuid(),
  branch_id: z.string().uuid().nullable(),
});

const FulfillmentOrderRowSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
});

const RecordRowSchema = z.object({
  fulfillment_id: z.string().uuid(),
  inventory_operation_id: z.string().uuid(),
});

const FulfillmentRowSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  inventory_location_id: z.string().uuid(),
  inventory_operation_id: z.string().uuid(),
  actor_membership_id: z.string().uuid().nullable(),
  fulfilled_at: z.string(),
  created_at: z.string(),
});

const FulfillmentLineRowSchema = z.object({
  id: z.string().uuid(),
  fulfillment_id: z.string().uuid(),
  line_number: z.number(),
  order_line_id: z.string().uuid(),
  variant_id: z.string().uuid(),
  quantity: z.union([z.number(), z.string()]),
});

const OrderLineRowSchema = z.object({
  id: z.string().uuid(),
  variant_id: z.string().uuid(),
  quantity: z.union([z.number(), z.string()]),
});

interface DatabaseErrorLike {
  readonly code?: string;
}

/**
 * Maps a PostgREST/PostgreSQL error to a stable fulfillment error. Raw SQLSTATEs and database messages
 * never escape this function. An unexpected privilege failure (42501) from the sanctioned path is a
 * server defect, not a client error, so it surfaces as a generic Error, not a FulfillmentError.
 */
function mapDatabaseError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "ID409":
      return new FulfillmentError("IDEMPOTENCY_CONFLICT");
    case "FF010":
      return new FulfillmentError("ORDER_NOT_FOUND");
    case "FF011":
      return new FulfillmentError("ORDER_CANCELLED");
    case "FF012":
      return new FulfillmentError("ORDER_LINE_NOT_FOUND");
    case "FF013":
      return new FulfillmentError("OVER_FULFILLMENT");
    case "FF020":
      return new FulfillmentError("LOCATION_NOT_FOUND");
    case "FF021":
      return new FulfillmentError("LOCATION_INACTIVE");
    case "FF022":
      return new FulfillmentError("LOCATION_CAPABILITY_DENIED");
    case "23514":
      // record_operation raises 23514 when on-hand would go negative (insufficient stock).
      return new FulfillmentError("INSUFFICIENT_STOCK");
    case "23503":
      return new FulfillmentError("TENANT_MISMATCH");
    case "22003":
      return new FulfillmentError("AMOUNT_OUT_OF_RANGE");
    case "22023":
    case "22P02":
    case "22004":
      return new FulfillmentError("INVALID_FULFILLMENT");
    default:
      return new Error("An unexpected fulfillment persistence error occurred.");
  }
}

/**
 * Server-only adapter around a service-role client. The client is deliberately private; this class
 * exposes no generic query/write escape hatch, no raw RPC name, and no commercial-data surface beyond
 * the authorized fulfillment aggregate. The mutation asserts the COMPOSITE FulfillmentExecutionProof;
 * commercial reads assert an ordinary AuthorizedOperationProof; the narrow bootstrap lookups run before
 * authorization by design and return only routing metadata.
 */
export class SupabaseFulfillmentRepository implements FulfillmentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async resolveReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: FulfillmentClientIntent,
  ): Promise<FulfillmentReplayPreflightResult> {
    const { data, error } = await this.client
      .schema(FULFILLMENTS_PRIVATE_SCHEMA)
      .rpc("resolve_fulfillment_replay_target", {
        p_tenant_id: tenantId,
        p_normalized_key: normalizedIdempotencyKey,
        p_intent: {
          order_id: intent.orderId,
          inventory_location_id: intent.inventoryLocationId,
          lines: intent.lines.map((line) => ({
            order_line_id: line.orderLineId,
            quantity: line.quantity,
          })),
        },
      });
    if (error) {
      throw mapDatabaseError(error);
    }

    const rows = Array.isArray(data) ? data : data === null ? [] : [data];
    if (rows.length === 0) {
      return { kind: "none" };
    }
    const row = ReplayRowSchema.parse(rows[0]);
    if (!row.fingerprint_matches) {
      return { kind: "conflict" };
    }
    if (
      row.fulfillment_id === null ||
      row.order_id === null ||
      row.inventory_location_id === null ||
      row.channel === null ||
      row.brand_id === null
    ) {
      throw new Error("Replay preflight returned a match without routing identifiers.");
    }
    return {
      kind: "replay",
      fulfillmentId: row.fulfillment_id,
      orderId: row.order_id,
      inventoryLocationId: row.inventory_location_id,
      channel: row.channel,
      brandId: row.brand_id,
      branchId: row.branch_id,
    };
  }

  async getOrderRouting(tenantId: string, orderId: string): Promise<OrderRouting | null> {
    const { data, error } = await this.client
      .from("orders")
      .select("id,channel,brand_id,branch_id")
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    const row = OrderRoutingRowSchema.parse(rows[0]);
    return {
      orderId: row.id,
      channel: row.channel,
      brandId: row.brand_id,
      branchId: row.branch_id,
    };
  }

  async getFulfillmentRouting(
    tenantId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentRouting | null> {
    const { data, error } = await this.client
      .from("fulfillments")
      .select("id,order_id")
      .eq("tenant_id", tenantId)
      .eq("id", fulfillmentId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    const fulfillment = FulfillmentOrderRowSchema.parse(rows[0]);
    const routing = await this.getOrderRouting(tenantId, fulfillment.order_id);
    if (routing === null) {
      // A Fulfillment always has an Order (FK restrict); a null here is a server invariant failure.
      throw new Error("Fulfillment references an order that could not be routed.");
    }
    return {
      fulfillmentId: fulfillment.id,
      orderId: routing.orderId,
      channel: routing.channel,
      brandId: routing.brandId,
      branchId: routing.branchId,
    };
  }

  async recordFulfillment(
    proof: FulfillmentExecutionProof,
    command: CreateFulfillmentCommand,
  ): Promise<{ readonly fulfillmentId: string; readonly inventoryOperationId: string }> {
    // The privileged mutation boundary requires the COMPOSITE proof. A plain AuthorizedOperationProof
    // (even a genuine inventory.issue one) is rejected here.
    assertFulfillmentExecutionProof(proof);

    const { data, error } = await this.client
      .schema(FULFILLMENTS_PRIVATE_SCHEMA)
      .rpc("record_fulfillment", {
        p_tenant_id: command.tenantId,
        p_order_id: command.orderId,
        p_inventory_location_id: command.inventoryLocationId,
        p_actor_membership_id: command.actorMembershipId,
        p_idempotency_key: command.idempotencyKey,
        p_fulfilled_at: null,
        p_lines: command.lines.map((line) => ({
          order_line_id: line.orderLineId,
          quantity: line.quantity,
        })),
      });
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = Array.isArray(data) ? data : data === null ? [] : [data];
    if (rows.length === 0) {
      throw new Error("record_fulfillment did not return an identifier row.");
    }
    const row = RecordRowSchema.parse(rows[0]);
    return { fulfillmentId: row.fulfillment_id, inventoryOperationId: row.inventory_operation_id };
  }

  async getFulfillment(
    proof: AuthorizedOperationContext,
    tenantId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentResult | null> {
    assertAuthorizedOperationProof(proof);

    const { data, error } = await this.client
      .from("fulfillments")
      .select(
        "id,order_id,inventory_location_id,inventory_operation_id,actor_membership_id,fulfilled_at,created_at",
      )
      .eq("tenant_id", tenantId)
      .eq("id", fulfillmentId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    const fulfillment = FulfillmentRowSchema.parse(rows[0]);
    const lines = await this.loadLines(tenantId, [fulfillment.id]);
    return this.toResult(fulfillment, lines.get(fulfillment.id) ?? []);
  }

  async getOrderFulfillments(
    proof: AuthorizedOperationContext,
    tenantId: string,
    orderId: string,
  ): Promise<readonly FulfillmentResult[]> {
    assertAuthorizedOperationProof(proof);

    const { data, error } = await this.client
      .from("fulfillments")
      .select(
        "id,order_id,inventory_location_id,inventory_operation_id,actor_membership_id,fulfilled_at,created_at",
      )
      .eq("tenant_id", tenantId)
      .eq("order_id", orderId)
      .order("fulfilled_at", { ascending: true })
      .order("id", { ascending: true });
    if (error) {
      throw mapDatabaseError(error);
    }
    const fulfillments = (data ?? []).map((row) => FulfillmentRowSchema.parse(row));
    if (fulfillments.length === 0) {
      return [];
    }
    const lines = await this.loadLines(
      tenantId,
      fulfillments.map((fulfillment) => fulfillment.id),
    );
    return fulfillments.map((fulfillment) =>
      this.toResult(fulfillment, lines.get(fulfillment.id) ?? []),
    );
  }

  async getOrderFulfillmentSummary(
    proof: AuthorizedOperationContext,
    tenantId: string,
    orderId: string,
  ): Promise<OrderFulfillmentSummary | null> {
    assertAuthorizedOperationProof(proof);

    const { data: orderLineData, error: orderLineError } = await this.client
      .from("order_lines")
      .select("id,variant_id,quantity")
      .eq("tenant_id", tenantId)
      .eq("order_id", orderId)
      .order("line_number", { ascending: true });
    if (orderLineError) {
      throw mapDatabaseError(orderLineError);
    }
    const orderLines = (orderLineData ?? []).map((row) => OrderLineRowSchema.parse(row));
    if (orderLines.length === 0) {
      // Every Order has at least one line; no lines means the Order does not exist in this tenant.
      return null;
    }

    const { data: fulfillmentLineData, error: fulfillmentLineError } = await this.client
      .from("fulfillment_lines")
      .select("order_line_id,quantity,fulfillment_id")
      .eq("tenant_id", tenantId)
      .eq("order_id", orderId);
    if (fulfillmentLineError) {
      throw mapDatabaseError(fulfillmentLineError);
    }
    const fulfillmentLines = (fulfillmentLineData ?? []).map((row) =>
      z
        .object({
          order_line_id: z.string().uuid(),
          quantity: z.union([z.number(), z.string()]),
          fulfillment_id: z.string().uuid(),
        })
        .parse(row),
    );

    const fulfilledByLine = new Map<string, number>();
    const fulfillmentIds = new Set<string>();
    for (const line of fulfillmentLines) {
      fulfilledByLine.set(
        line.order_line_id,
        (fulfilledByLine.get(line.order_line_id) ?? 0) + toSafeInteger(line.quantity),
      );
      fulfillmentIds.add(line.fulfillment_id);
    }

    const lines: OrderFulfillmentLineSummary[] = orderLines.map((orderLine) => {
      const ordered = toSafeInteger(orderLine.quantity);
      const fulfilled = fulfilledByLine.get(orderLine.id) ?? 0;
      return {
        orderLineId: orderLine.id,
        variantId: orderLine.variant_id,
        orderedQuantity: ordered,
        fulfilledQuantity: fulfilled,
        status: progressStatus(fulfilled, ordered),
      };
    });

    const totalOrdered = lines.reduce((sum, line) => sum + line.orderedQuantity, 0);
    const totalFulfilled = lines.reduce((sum, line) => sum + line.fulfilledQuantity, 0);

    return {
      orderId,
      status: progressStatus(totalFulfilled, totalOrdered),
      lines,
      fulfillmentIds: [...fulfillmentIds],
    };
  }

  private async loadLines(
    tenantId: string,
    fulfillmentIds: readonly string[],
  ): Promise<Map<string, ReturnType<typeof FulfillmentLineRowSchema.parse>[]>> {
    const grouped = new Map<string, ReturnType<typeof FulfillmentLineRowSchema.parse>[]>();
    if (fulfillmentIds.length === 0) {
      return grouped;
    }
    const { data, error } = await this.client
      .from("fulfillment_lines")
      .select("id,fulfillment_id,line_number,order_line_id,variant_id,quantity")
      .eq("tenant_id", tenantId)
      .in("fulfillment_id", [...fulfillmentIds])
      .order("line_number", { ascending: true });
    if (error) {
      throw mapDatabaseError(error);
    }
    for (const raw of data ?? []) {
      const line = FulfillmentLineRowSchema.parse(raw);
      const bucket = grouped.get(line.fulfillment_id) ?? [];
      bucket.push(line);
      grouped.set(line.fulfillment_id, bucket);
    }
    return grouped;
  }

  private toResult(
    fulfillment: ReturnType<typeof FulfillmentRowSchema.parse>,
    lines: readonly ReturnType<typeof FulfillmentLineRowSchema.parse>[],
  ): FulfillmentResult {
    return {
      id: fulfillment.id,
      orderId: fulfillment.order_id,
      inventoryLocationId: fulfillment.inventory_location_id,
      inventoryOperationId: fulfillment.inventory_operation_id,
      actorMembershipId: fulfillment.actor_membership_id,
      fulfilledAt: fulfillment.fulfilled_at,
      createdAt: fulfillment.created_at,
      lines: lines.map((line) => ({
        id: line.id,
        lineNumber: line.line_number,
        orderLineId: line.order_line_id,
        variantId: line.variant_id,
        quantity: toSafeInteger(line.quantity),
      })),
    };
  }
}

function progressStatus(fulfilled: number, ordered: number): FulfillmentProgressStatus {
  if (fulfilled <= 0) {
    return "unfulfilled";
  }
  if (fulfilled >= ordered) {
    return "fulfilled";
  }
  return "partially_fulfilled";
}

export interface SupabaseFulfillmentRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseFulfillmentRepository(
  configuration: SupabaseFulfillmentRepositoryConfiguration,
): SupabaseFulfillmentRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseFulfillmentRepository(client);
}
