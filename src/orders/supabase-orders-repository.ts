import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import { OrderError } from "./errors";
import type {
  OrderChannel,
  OrderClientIntent,
  OrderLineCatalogState,
  OrderResult,
  OrderRouting,
  RegisterContext,
  ReplayPreflightResult,
} from "./model";
import type { CancelOrderCommand, CreateOrderCommand, OrderRepository } from "./repository";

// The private schema that owns the sanctioned functions. It is exposed to PostgREST so the
// service-role client can call the functions by name; execution is gated by the EXECUTE grants
// (service_role only), never by schema exposure.
const ORDERS_PRIVATE_SCHEMA = "orders_private";

// A bigint column/return that must round-trip through JSON without precision loss. PostgREST may hand
// back int8 as a number or a string. The Phase 2D application contract carries money and quantities as
// JS safe integers while the database stays bigint; a value outside that range is a numeric
// transport/invariant failure, NOT a business condition. It surfaces as a generic internal error and
// never as a domain error such as TENANT_MISMATCH.
function toSafeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error("An order amount is outside the supported application range.");
  }
  return parsed;
}

const ReplayRowSchema = z.object({
  fingerprint_matches: z.boolean(),
  order_id: z.string().uuid().nullable(),
  channel: z.enum(["pos", "online"]).nullable(),
  brand_id: z.string().uuid().nullable(),
  branch_id: z.string().uuid().nullable(),
});

const RegisterRowSchema = z.object({
  branch_id: z.string().uuid(),
  status: z.enum(["active", "inactive", "archived"]),
});

const RoutingRowSchema = z.object({
  id: z.string().uuid(),
  channel: z.enum(["pos", "online"]),
  brand_id: z.string().uuid(),
  branch_id: z.string().uuid().nullable(),
});

const VariantProductRowSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
});

const ProductBrandRowSchema = z.object({
  id: z.string().uuid(),
  brand_id: z.string().uuid(),
  name: z.string(),
});

const VariantCatalogRowSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  status: z.enum(["draft", "active", "archived"]),
  display_name: z.string().nullable(),
  sku: z.string(),
});

const OrderRowSchema = z.object({
  id: z.string().uuid(),
  order_number: z.string(),
  channel: z.enum(["pos", "online"]),
  status: z.enum(["placed", "cancelled"]),
  brand_id: z.string().uuid(),
  branch_id: z.string().uuid().nullable(),
  register_id: z.string().uuid().nullable(),
  currency: z.string(),
  total_minor: z.union([z.number(), z.string()]),
  actor_membership_id: z.string().uuid().nullable(),
  placed_at: z.string(),
  cancelled_at: z.string().nullable(),
  cancelled_by_membership_id: z.string().uuid().nullable(),
  cancellation_reason: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const OrderLineRowSchema = z.object({
  id: z.string().uuid(),
  line_number: z.number(),
  variant_id: z.string().uuid(),
  quantity: z.union([z.number(), z.string()]),
  unit_price_minor: z.union([z.number(), z.string()]),
  line_total_minor: z.union([z.number(), z.string()]),
  product_name_snapshot: z.string(),
  variant_name_snapshot: z.string().nullable(),
  sku_snapshot: z.string(),
  option_summary_snapshot: z.string().nullable(),
});

interface DatabaseErrorLike {
  readonly code?: string;
}

/**
 * Maps a PostgREST/PostgreSQL error to a stable order error. Raw SQLSTATEs and database messages never
 * escape this function. An unexpected privilege failure (42501) from the sanctioned path is a server
 * defect, not a client error, so it surfaces as a generic Error, not an OrderError. Money range
 * failures map to AMOUNT_OUT_OF_RANGE, never to a resource-existence error.
 */
function mapDatabaseError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "ID409":
      return new OrderError("IDEMPOTENCY_CONFLICT");
    case "FF030":
      // Phase 2E: cancel_order refuses an order that has any Fulfillment (partial or full). This is a
      // stable business conflict, not an unexpected fault.
      return new OrderError("ORDER_ALREADY_FULFILLED");
    case "23514":
      return new OrderError("INVALID_ORDER");
    case "23503":
      return new OrderError("TENANT_MISMATCH");
    case "22003":
      return new OrderError("AMOUNT_OUT_OF_RANGE");
    case "22023":
    case "22P02":
    case "22004":
      return new OrderError("INVALID_ORDER");
    default:
      return new Error("An unexpected order persistence error occurred.");
  }
}

/**
 * Server-only adapter around a service-role client. The client is deliberately private; this class
 * exposes no generic query/write escape hatch, no raw RPC name, and no commercial-data surface beyond
 * the authorized order aggregate. Commercial reads/mutations assert the authorization proof before any
 * privileged access. The narrow authorization-bootstrap lookups (documented on OrderRepository) run
 * before authorization by design and return only routing/foundational metadata.
 */
export class SupabaseOrdersRepository implements OrderRepository {
  constructor(private readonly client: SupabaseClient) {}

  async resolveIdempotentReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: OrderClientIntent,
  ): Promise<ReplayPreflightResult> {
    const { data, error } = await this.client
      .schema(ORDERS_PRIVATE_SCHEMA)
      .rpc("resolve_idempotent_replay_target", {
        p_tenant_id: tenantId,
        p_normalized_key: normalizedIdempotencyKey,
        p_intent: {
          channel: intent.channel,
          currency: intent.currency,
          register_id: intent.registerId,
          lines: intent.lines.map((line) => ({
            variant_id: line.variantId,
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
    if (row.order_id === null || row.channel === null || row.brand_id === null) {
      // A matching fingerprint always carries identifiers; a null here is a server invariant failure.
      throw new Error("Replay preflight returned a match without routing identifiers.");
    }
    return {
      kind: "replay",
      orderId: row.order_id,
      channel: row.channel,
      brandId: row.brand_id,
      branchId: row.branch_id,
    };
  }

  async getRegisterContext(tenantId: string, registerId: string): Promise<RegisterContext | null> {
    const { data, error } = await this.client
      .from("registers")
      .select("branch_id,status")
      .eq("tenant_id", tenantId)
      .eq("id", registerId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    const row = RegisterRowSchema.parse(rows[0]);
    return { branchId: row.branch_id, status: row.status };
  }

  async deriveBrandForVariants(
    tenantId: string,
    variantIds: readonly string[],
  ): Promise<{ brandId: string } | { crossBrand: true } | null> {
    const uniqueVariantIds = [...new Set(variantIds)];

    const { data: variantData, error: variantError } = await this.client
      .from("product_variants")
      .select("id,product_id")
      .eq("tenant_id", tenantId)
      .in("id", uniqueVariantIds);
    if (variantError) {
      throw mapDatabaseError(variantError);
    }
    const variantRows = (variantData ?? []).map((row) => VariantProductRowSchema.parse(row));
    if (variantRows.length !== uniqueVariantIds.length) {
      return null; // at least one requested variant does not exist in this tenant
    }

    const productIds = [...new Set(variantRows.map((row) => row.product_id))];
    const { data: productData, error: productError } = await this.client
      .from("products")
      .select("id,brand_id,name")
      .eq("tenant_id", tenantId)
      .in("id", productIds);
    if (productError) {
      throw mapDatabaseError(productError);
    }
    const productRows = (productData ?? []).map((row) => ProductBrandRowSchema.parse(row));
    if (productRows.length !== productIds.length) {
      return null;
    }

    const brandIds = new Set(productRows.map((row) => row.brand_id));
    if (brandIds.size === 0) {
      return null;
    }
    if (brandIds.size > 1) {
      return { crossBrand: true };
    }
    return { brandId: [...brandIds][0] as string };
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
    return this.toRouting(data ?? []);
  }

  async getOrderRoutingByNumber(
    tenantId: string,
    normalizedOrderNumber: string,
  ): Promise<OrderRouting | null> {
    const { data, error } = await this.client
      .from("orders")
      .select("id,channel,brand_id,branch_id")
      .eq("tenant_id", tenantId)
      .eq("normalized_order_number", normalizedOrderNumber)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    return this.toRouting(data ?? []);
  }

  async getBranchStatus(
    proof: AuthorizedOperationContext,
    tenantId: string,
    branchId: string,
  ): Promise<"active" | "inactive" | "archived" | null> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("branches")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("id", branchId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    return z
      .enum(["active", "inactive", "archived"])
      .parse((rows[0] as { status: unknown }).status);
  }

  async isBrandCarriedByBranch(
    proof: AuthorizedOperationContext,
    tenantId: string,
    branchId: string,
    brandId: string,
  ): Promise<boolean> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("branch_brands")
      .select("brand_id")
      .eq("tenant_id", tenantId)
      .eq("branch_id", branchId)
      .eq("brand_id", brandId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    return (data ?? []).length > 0;
  }

  async getOrderLineCatalogState(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
  ): Promise<OrderLineCatalogState | null> {
    assertAuthorizedOperationProof(proof);

    const { data: variantData, error: variantError } = await this.client
      .from("product_variants")
      .select("id,product_id,status,display_name,sku")
      .eq("tenant_id", tenantId)
      .eq("id", variantId)
      .limit(1);
    if (variantError) {
      throw mapDatabaseError(variantError);
    }
    const variantRows = variantData ?? [];
    if (variantRows.length === 0) {
      return null;
    }
    const variant = VariantCatalogRowSchema.parse(variantRows[0]);

    const { data: productData, error: productError } = await this.client
      .from("products")
      .select("id,brand_id,name")
      .eq("tenant_id", tenantId)
      .eq("id", variant.product_id)
      .limit(1);
    if (productError) {
      throw mapDatabaseError(productError);
    }
    const productRows = productData ?? [];
    if (productRows.length === 0) {
      return null;
    }
    const product = ProductBrandRowSchema.parse(productRows[0]);

    const optionSummary = await this.resolveOptionSummary(tenantId, variantId);

    return {
      variantId: variant.id,
      productId: variant.product_id,
      brandId: product.brand_id,
      variantStatus: variant.status,
      productName: product.name,
      variantName: variant.display_name,
      sku: variant.sku,
      optionSummary,
    };
  }

  async getActiveUnitPrice(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
    currency: string,
  ): Promise<number | null> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("variant_prices")
      .select("amount_minor")
      .eq("tenant_id", tenantId)
      .eq("variant_id", variantId)
      .eq("currency", currency)
      .eq("status", "active")
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    return toSafeInteger((rows[0] as { amount_minor: unknown }).amount_minor);
  }

  async createOrder(
    proof: AuthorizedOperationContext,
    command: CreateOrderCommand,
  ): Promise<string> {
    assertAuthorizedOperationProof(proof);

    const { data, error } = await this.client.schema(ORDERS_PRIVATE_SCHEMA).rpc("create_order", {
      p_tenant_id: command.tenantId,
      p_channel: command.channel,
      p_currency: command.currency,
      p_brand_id: command.brandId,
      p_branch_id: command.branchId,
      p_register_id: command.registerId,
      p_actor_membership_id: command.actorMembershipId,
      p_idempotency_key: command.idempotencyKey,
      p_placed_at: null,
      p_notes: command.notes ?? null,
      p_lines: command.lines.map((line) => ({
        variant_id: line.variantId,
        product_id: line.productId,
        quantity: line.quantity,
        unit_price_minor: line.unitPriceMinor,
        product_name: line.productName,
        variant_name: line.variantName,
        sku: line.sku,
        option_summary: line.optionSummary,
      })),
    });
    if (error) {
      throw mapDatabaseError(error);
    }
    const orderId = z.string().uuid().safeParse(data);
    if (!orderId.success) {
      throw new Error("create_order did not return an order id.");
    }
    return orderId.data;
  }

  async cancelOrder(proof: AuthorizedOperationContext, command: CancelOrderCommand): Promise<void> {
    assertAuthorizedOperationProof(proof);

    const { error } = await this.client.schema(ORDERS_PRIVATE_SCHEMA).rpc("cancel_order", {
      p_tenant_id: command.tenantId,
      p_order_id: command.orderId,
      p_cancelled_by_membership_id: command.cancelledByMembershipId,
      p_reason: command.reason ?? null,
    });
    if (error) {
      throw mapDatabaseError(error);
    }
  }

  async getOrder(
    proof: AuthorizedOperationContext,
    tenantId: string,
    orderId: string,
  ): Promise<OrderResult | null> {
    assertAuthorizedOperationProof(proof);

    const { data: orderData, error: orderError } = await this.client
      .from("orders")
      .select(
        "id,order_number,channel,status,brand_id,branch_id,register_id,currency,total_minor," +
          "actor_membership_id,placed_at,cancelled_at,cancelled_by_membership_id,cancellation_reason," +
          "notes,created_at,updated_at",
      )
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .limit(1);
    if (orderError) {
      throw mapDatabaseError(orderError);
    }
    const orderRows = orderData ?? [];
    if (orderRows.length === 0) {
      return null;
    }
    const order = OrderRowSchema.parse(orderRows[0]);

    const { data: lineData, error: lineError } = await this.client
      .from("order_lines")
      .select(
        "id,line_number,variant_id,quantity,unit_price_minor,line_total_minor," +
          "product_name_snapshot,variant_name_snapshot,sku_snapshot,option_summary_snapshot",
      )
      .eq("tenant_id", tenantId)
      .eq("order_id", orderId)
      .order("line_number", { ascending: true });
    if (lineError) {
      throw mapDatabaseError(lineError);
    }

    const lines = (lineData ?? []).map((row) => {
      const line = OrderLineRowSchema.parse(row);
      return {
        id: line.id,
        lineNumber: line.line_number,
        variantId: line.variant_id,
        quantity: toSafeInteger(line.quantity),
        unitPriceMinor: toSafeInteger(line.unit_price_minor),
        lineTotalMinor: toSafeInteger(line.line_total_minor),
        productName: line.product_name_snapshot,
        variantName: line.variant_name_snapshot,
        sku: line.sku_snapshot,
        optionSummary: line.option_summary_snapshot,
      };
    });

    return {
      id: order.id,
      orderNumber: order.order_number,
      channel: order.channel as OrderChannel,
      status: order.status,
      brandId: order.brand_id,
      branchId: order.branch_id,
      registerId: order.register_id,
      currency: order.currency,
      totalMinor: toSafeInteger(order.total_minor),
      actorMembershipId: order.actor_membership_id,
      placedAt: order.placed_at,
      cancelledAt: order.cancelled_at,
      cancelledByMembershipId: order.cancelled_by_membership_id,
      cancellationReason: order.cancellation_reason,
      notes: order.notes,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      lines,
    };
  }

  private toRouting(rows: readonly unknown[]): OrderRouting | null {
    if (rows.length === 0) {
      return null;
    }
    const row = RoutingRowSchema.parse(rows[0]);
    return {
      orderId: row.id,
      channel: row.channel,
      brandId: row.brand_id,
      branchId: row.branch_id,
    };
  }

  /**
   * Builds a deterministic, human-readable option summary (e.g. "Color: Black / Size: M") from the
   * variant's selected option values, ordered by option position then name. Returns null when the
   * variant has no selected options. Never stores arbitrary JSON.
   */
  private async resolveOptionSummary(tenantId: string, variantId: string): Promise<string | null> {
    const { data: selectionData, error: selectionError } = await this.client
      .from("variant_option_values")
      .select("option_id,option_value_id")
      .eq("tenant_id", tenantId)
      .eq("variant_id", variantId);
    if (selectionError) {
      throw mapDatabaseError(selectionError);
    }
    const selections = (selectionData ?? []).map((row) =>
      z.object({ option_id: z.string().uuid(), option_value_id: z.string().uuid() }).parse(row),
    );
    if (selections.length === 0) {
      return null;
    }

    const optionIds = [...new Set(selections.map((s) => s.option_id))];
    const valueIds = [...new Set(selections.map((s) => s.option_value_id))];

    const { data: optionData, error: optionError } = await this.client
      .from("product_options")
      .select("id,name,position")
      .eq("tenant_id", tenantId)
      .in("id", optionIds);
    if (optionError) {
      throw mapDatabaseError(optionError);
    }
    const options = new Map(
      (optionData ?? [])
        .map((row) =>
          z.object({ id: z.string().uuid(), name: z.string(), position: z.number() }).parse(row),
        )
        .map((row) => [row.id, { name: row.name, position: row.position }]),
    );

    const { data: valueData, error: valueError } = await this.client
      .from("product_option_values")
      .select("id,display_value")
      .eq("tenant_id", tenantId)
      .in("id", valueIds);
    if (valueError) {
      throw mapDatabaseError(valueError);
    }
    const values = new Map(
      (valueData ?? [])
        .map((row) => z.object({ id: z.string().uuid(), display_value: z.string() }).parse(row))
        .map((row) => [row.id, row.display_value]),
    );

    const parts = selections
      .map((selection) => {
        const option = options.get(selection.option_id);
        const value = values.get(selection.option_value_id);
        if (option === undefined || value === undefined) {
          return null;
        }
        return { position: option.position, name: option.name, value };
      })
      .filter((part): part is { position: number; name: string; value: string } => part !== null)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((part) => `${part.name}: ${part.value}`);

    return parts.length === 0 ? null : parts.join(" / ");
  }
}

export interface SupabaseOrdersRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseOrdersRepository(
  configuration: SupabaseOrdersRepositoryConfiguration,
): SupabaseOrdersRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseOrdersRepository(client);
}
