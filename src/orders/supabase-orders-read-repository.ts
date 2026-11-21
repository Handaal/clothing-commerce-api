import {
  OrderCommerceDetailsSchema,
  PaymentSummarySchema,
  type OrderCommerceDetails,
} from "../contracts/storefront/checkout";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { normalizeTimestampUtc, toSafeInteger } from "../management/db-serialization";
import type { OrderListQuery, OrderListRow, OrdersReadRepository } from "./orders-read-repository";

const IdRowSchema = z.object({ id: z.string().uuid() });

const OrderListRowSchema = z.object({
  id: z.string().uuid(),
  order_number: z.string(),
  channel: z.enum(["pos", "online"]),
  status: z.enum(["placed", "cancelled"]),
  brand_id: z.string().uuid(),
  branch_id: z.string().uuid().nullable(),
  currency: z.string(),
  total_minor: z.union([z.number(), z.string()]),
  delivery_fee_minor: z.union([z.number(), z.string()]).optional(),
  placed_at: z.string().min(1),
  customer_snapshot: z.unknown().optional(),
  delivery_snapshot: z.unknown().optional(),
});

const ListLineRowSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  quantity: z.union([z.number(), z.string()]),
});
const ListFulfilledRowSchema = z.object({
  order_line_id: z.string().uuid(),
  quantity: z.union([z.number(), z.string()]),
});

const LineLabelRowSchema = z.object({
  line_number: z.number().int(),
  variant_name_snapshot: z.string().nullable().optional(),
  option_summary_snapshot: z.string().nullable().optional(),
});
const OptionValueRowSchema = z.object({ id: z.string().uuid(), display_value: z.string() });
const UUID_LIST =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s*,\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/iu;

/** The option value ids of an id-list snapshot, or null when the snapshot is readable text. */
function optionIdList(snapshot: string | null | undefined): string[] | null {
  const text = snapshot?.trim();
  if (!text || !UUID_LIST.test(text)) return null;
  return text.split(",").map((id) => id.trim().toLowerCase());
}

/** A string field from a stored JSON snapshot, or null. */
function snapshotText(snapshot: unknown, key: string): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error("Orders read row failed validation.");
  }
  return parsed.data;
}

function requireNoQueryError(error: unknown): void {
  if (error) {
    throw new Error("An unexpected orders read query error occurred.");
  }
}

function keysetExpression(cursor: OrderListQuery["cursor"]): string | null {
  if (cursor === null) {
    return null;
  }
  return `placed_at.lt.${cursor.placedAt},and(placed_at.eq.${cursor.placedAt},id.lt.${cursor.id})`;
}

export class SupabaseOrdersReadRepository implements OrdersReadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getCommerceDetails(tenantId: string, orderId: string): Promise<OrderCommerceDetails> {
    const [order, payment, reservations] = await Promise.all([
      this.client
        .from("orders")
        .select("customer_id,customer_snapshot,delivery_snapshot,delivery_fee_minor")
        .eq("tenant_id", tenantId)
        .eq("id", orderId)
        .single(),
      this.client
        .from("payments")
        .select("method,provider,status,amount_minor,currency")
        .eq("tenant_id", tenantId)
        .eq("order_id", orderId)
        .maybeSingle(),
      this.client
        .from("stock_reservations")
        .select("variant_id,inventory_location_id,quantity,consumed_quantity,status,expires_at")
        .eq("tenant_id", tenantId)
        .eq("order_id", orderId)
        .order("variant_id"),
    ]);
    for (const result of [order, payment, reservations]) requireNoQueryError(result.error);
    const o = z
      .object({
        customer_id: z.string().nullable(),
        customer_snapshot: z.unknown(),
        delivery_snapshot: z.unknown(),
        delivery_fee_minor: z.union([z.number(), z.string()]).optional(),
      })
      .parse(order.data);
    const p =
      payment.data === null
        ? null
        : z
            .object({
              method: z.string(),
              provider: z.string().nullable(),
              status: z.string(),
              amount_minor: z.union([z.number(), z.string()]),
              currency: z.string(),
            })
            .parse(payment.data);
    const rows = z
      .array(
        z.object({
          variant_id: z.string(),
          inventory_location_id: z.string(),
          quantity: z.union([z.number(), z.string()]),
          consumed_quantity: z.union([z.number(), z.string()]),
          status: z.string(),
          expires_at: z.string().nullable(),
        }),
      )
      .parse(reservations.data);
    return OrderCommerceDetailsSchema.parse({
      deliveryFeeMinor: toSafeInteger(o.delivery_fee_minor ?? 0),
      customerId: o.customer_id,
      customer: o.customer_snapshot,
      delivery: o.delivery_snapshot,
      payment:
        p === null
          ? null
          : PaymentSummarySchema.parse({
              method: p.method,
              provider: p.provider,
              status: p.status,
              amountMinor: toSafeInteger(p.amount_minor),
              currency: p.currency,
            }),
      reservations: rows.map((r) => ({
        variantId: r.variant_id,
        inventoryLocationId: r.inventory_location_id,
        quantity: toSafeInteger(r.quantity),
        consumedQuantity: toSafeInteger(r.consumed_quantity),
        status: r.status,
        expiresAt: r.expires_at === null ? null : normalizeTimestampUtc(r.expires_at),
      })),
    });
  }

  /** Where each order line's online stock hold lives (any status: consumed holds keep their location). */
  async getReservationLocations(
    tenantId: string,
    orderId: string,
  ): Promise<readonly { orderLineId: string; inventoryLocationId: string }[]> {
    const { data, error } = await this.client
      .from("stock_reservations")
      .select("order_line_id,inventory_location_id")
      .eq("tenant_id", tenantId)
      .eq("order_id", orderId);
    requireNoQueryError(error);
    return z
      .array(
        z.object({ order_line_id: z.string().uuid(), inventory_location_id: z.string().uuid() }),
      )
      .parse(data)
      .map((row) => ({
        orderLineId: row.order_line_id,
        inventoryLocationId: row.inventory_location_id,
      }));
  }

  async brandExistsInTenant(tenantId: string, brandId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("brands")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", brandId)
      .limit(1);
    requireNoQueryError(error);
    return parseRows(IdRowSchema, data).length === 1;
  }

  async branchExistsInTenant(tenantId: string, branchId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("branches")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", branchId)
      .limit(1);
    requireNoQueryError(error);
    return parseRows(IdRowSchema, data).length === 1;
  }

  async getLineLabels(
    tenantId: string,
    orderId: string,
  ): Promise<Map<number, { variantName: string | null; optionSummary: string | null }>> {
    const { data, error } = await this.client
      .from("order_lines")
      .select("line_number,variant_name_snapshot,option_summary_snapshot")
      .eq("tenant_id", tenantId)
      .eq("order_id", orderId);
    requireNoQueryError(error);
    const rows = parseRows(LineLabelRowSchema, data);
    // Online lines snapshot option VALUE ids ("uuid,uuid"); POS lines snapshot readable text. Resolve
    // ids to their display values in the listed order ("S · White"), like the Storefront tracker.
    const ids = new Set<string>();
    for (const row of rows) {
      for (const id of optionIdList(row.option_summary_snapshot) ?? []) ids.add(id);
    }
    const names = new Map<string, string>();
    if (ids.size > 0) {
      const values = await this.client
        .from("product_option_values")
        .select("id,display_value")
        .eq("tenant_id", tenantId)
        .in("id", [...ids]);
      requireNoQueryError(values.error);
      for (const value of parseRows(OptionValueRowSchema, values.data)) {
        names.set(value.id, value.display_value);
      }
    }
    const labels = new Map<number, { variantName: string | null; optionSummary: string | null }>();
    for (const row of rows) {
      const raw = row.option_summary_snapshot?.trim() || null;
      const idList = optionIdList(raw);
      const optionSummary = idList
        ? idList
            .map((id) => names.get(id))
            .filter((name): name is string => Boolean(name))
            .join(" · ") || null
        : raw;
      labels.set(row.line_number, {
        variantName: row.variant_name_snapshot?.trim() || null,
        optionSummary,
      });
    }
    return labels;
  }

  /**
   * Order-level fulfilment progress for one list page, from two batched reads (the page's order lines
   * and their fulfilled quantities). Same rule as the detail summary: nothing shipped = unfulfilled,
   * every line fully shipped = fulfilled, anything between = partially_fulfilled.
   */
  private async fulfillmentStatuses(
    tenantId: string,
    orderIds: readonly string[],
  ): Promise<Map<string, "unfulfilled" | "partially_fulfilled" | "fulfilled">> {
    const result = new Map<string, "unfulfilled" | "partially_fulfilled" | "fulfilled">();
    if (orderIds.length === 0) return result;
    const [lines, fulfilled] = await Promise.all([
      this.client
        .from("order_lines")
        .select("id,order_id,quantity")
        .eq("tenant_id", tenantId)
        .in("order_id", [...orderIds]),
      this.client
        .from("fulfillment_lines")
        .select("order_line_id,quantity")
        .eq("tenant_id", tenantId)
        .in("order_id", [...orderIds]),
    ]);
    requireNoQueryError(lines.error);
    requireNoQueryError(fulfilled.error);
    const shipped = new Map<string, number>();
    for (const row of parseRows(ListFulfilledRowSchema, fulfilled.data)) {
      shipped.set(
        row.order_line_id,
        (shipped.get(row.order_line_id) ?? 0) + toSafeInteger(row.quantity),
      );
    }
    const totals = new Map<string, { ordered: number; done: number; any: boolean }>();
    for (const row of parseRows(ListLineRowSchema, lines.data)) {
      const ordered = toSafeInteger(row.quantity);
      const done = Math.min(ordered, shipped.get(row.id) ?? 0);
      const entry = totals.get(row.order_id) ?? { ordered: 0, done: 0, any: false };
      entry.ordered += ordered;
      entry.done += done;
      entry.any ||= done > 0;
      totals.set(row.order_id, entry);
    }
    for (const [orderId, entry] of totals) {
      result.set(
        orderId,
        entry.ordered > 0 && entry.done >= entry.ordered
          ? "fulfilled"
          : entry.any
            ? "partially_fulfilled"
            : "unfulfilled",
      );
    }
    return result;
  }

  async listOrders(query: OrderListQuery): Promise<OrderListRow[]> {
    let request = this.client
      .from("orders")
      .select(
        "id,order_number,channel,status,brand_id,branch_id,currency,total_minor,delivery_fee_minor,placed_at,customer_snapshot,delivery_snapshot",
      )
      .eq("tenant_id", query.tenantId);

    if (query.filters.channel !== undefined) {
      request = request.eq("channel", query.filters.channel);
    }
    if (query.filters.status !== undefined) {
      request = request.eq("status", query.filters.status);
    }
    if (query.filters.brandId !== undefined) {
      request = request.eq("brand_id", query.filters.brandId);
    }
    if (query.filters.branchId !== undefined) {
      request = request.eq("branch_id", query.filters.branchId);
    }

    // Visibility predicate FIRST, folding the keyset into the same top-level boolean so at most one
    // PostgREST `or=` param is ever emitted (the channel-split visibility and the keyset are both ORs
    // and would otherwise collide as two separate top-level `or=` params).
    const keyset = keysetExpression(query.cursor);
    const { visibility } = query;
    if (visibility.tenantWide) {
      if (keyset !== null) {
        request = request.or(keyset);
      }
    } else {
      const hasBrands = visibility.brandIds.length > 0;
      const hasBranches = visibility.branchIds.length > 0;
      if (hasBrands && hasBranches) {
        const keysetSuffix = keyset === null ? "" : `,or(${keyset})`;
        const brandList = `(${visibility.brandIds.join(",")})`;
        const branchList = `(${visibility.branchIds.join(",")})`;
        request = request.or(
          `and(channel.eq.online,brand_id.in.${brandList}${keysetSuffix}),` +
            `and(channel.eq.pos,branch_id.in.${branchList}${keysetSuffix})`,
        );
      } else if (hasBrands) {
        request = request.eq("channel", "online").in("brand_id", [...visibility.brandIds]);
        if (keyset !== null) {
          request = request.or(keyset);
        }
      } else {
        request = request.eq("channel", "pos").in("branch_id", [...visibility.branchIds]);
        if (keyset !== null) {
          request = request.or(keyset);
        }
      }
    }

    const { data, error } = await request
      .order("placed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.fetchLimit);
    requireNoQueryError(error);

    const rows = parseRows(OrderListRowSchema, data);
    const fulfillment = await this.fulfillmentStatuses(
      query.tenantId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      summary: {
        id: row.id,
        orderNumber: row.order_number,
        channel: row.channel,
        status: row.status,
        brandId: row.brand_id,
        branchId: row.branch_id,
        currency: row.currency,
        totalMinor: toSafeInteger(row.total_minor),
        deliveryFeeMinor: toSafeInteger(row.delivery_fee_minor ?? 0),
        placedAt: normalizeTimestampUtc(row.placed_at),
        fulfillmentStatus: fulfillment.get(row.id) ?? "unfulfilled",
        customerName: snapshotText(row.customer_snapshot, "name"),
        customerPhone: snapshotText(row.customer_snapshot, "phone"),
        deliveryCity: snapshotText(row.delivery_snapshot, "city"),
      },
      cursor: { placedAt: normalizeTimestampUtc(row.placed_at), id: row.id },
    }));
  }
}

export interface SupabaseOrdersReadRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseOrdersReadRepository(
  configuration: SupabaseOrdersReadRepositoryConfiguration,
): SupabaseOrdersReadRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseOrdersReadRepository(client);
}
