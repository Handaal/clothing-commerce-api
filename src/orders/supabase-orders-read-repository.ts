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
  placed_at: z.string().min(1),
});

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
        .select("customer_id,customer_snapshot,delivery_snapshot")
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

  async listOrders(query: OrderListQuery): Promise<OrderListRow[]> {
    let request = this.client
      .from("orders")
      .select("id,order_number,channel,status,brand_id,branch_id,currency,total_minor,placed_at")
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

    return parseRows(OrderListRowSchema, data).map((row) => ({
      summary: {
        id: row.id,
        orderNumber: row.order_number,
        channel: row.channel,
        status: row.status,
        brandId: row.brand_id,
        branchId: row.branch_id,
        currency: row.currency,
        totalMinor: toSafeInteger(row.total_minor),
        placedAt: normalizeTimestampUtc(row.placed_at),
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
