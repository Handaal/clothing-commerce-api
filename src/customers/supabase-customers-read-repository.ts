import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { normalizeTimestampUtc, toSafeInteger } from "../management/db-serialization";
import type {
  CustomerAggregate,
  CustomerListParams,
  CustomerListRow,
  CustomerOrderListRow,
  CustomerOrdersParams,
  CustomerRow,
  CustomersReadRepository,
} from "./customers-read-repository";

const CustomerRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  created_at: z.string().min(1),
});

const OrderRowSchema = z.object({
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

const AggregateRowSchema = z.object({
  customer_id: z.string().uuid(),
  total_minor: z.union([z.number(), z.string()]),
  currency: z.string(),
  placed_at: z.string().min(1),
});

function requireNoQueryError(error: unknown): void {
  if (error) throw new Error("An unexpected customers read query error occurred.");
}

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) throw new Error("Customers read row failed validation.");
  return parsed.data;
}

function toRow(raw: z.infer<typeof CustomerRowSchema>): CustomerRow {
  return {
    id: raw.id,
    name: raw.name,
    phone: raw.phone,
    email: raw.email,
    createdAt: normalizeTimestampUtc(raw.created_at),
  };
}

// Strip PostgREST filter-grammar metacharacters from a free-text term so it can be embedded safely in
// an ilike pattern. The result only positions a case-insensitive contains match; it carries no authority.
function sanitizeTerm(term: string): string {
  return term.replace(/[(),*:."'\\]/g, " ").trim();
}

export class SupabaseCustomersReadRepository implements CustomersReadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listCustomers(params: CustomerListParams): Promise<CustomerListRow[]> {
    const term = params.search ? sanitizeTerm(params.search) : "";
    const phoneTerm = params.search ? params.search.replace(/[^+0-9]/g, "") : "";
    const searchSub =
      term === "" && phoneTerm === ""
        ? null
        : `or(name.ilike.*${term}*,normalized_phone.ilike.*${phoneTerm}*)`;
    const keysetSub =
      params.cursor === null
        ? null
        : `or(created_at.lt.${params.cursor.createdAt},and(created_at.eq.${params.cursor.createdAt},id.lt.${params.cursor.id}))`;

    let request = this.client
      .from("customers")
      .select("id,name,phone,email,created_at")
      .eq("tenant_id", params.tenantId);

    // Emit at most ONE top-level or= param: combine search and keyset under a single and() when both
    // are present (two separate .or() calls would collide into one param and drop a predicate).
    if (searchSub !== null && keysetSub !== null) {
      request = request.or(`and(${searchSub},${keysetSub})`);
    } else if (searchSub !== null) {
      request = request.or(searchSub.slice(3, -1));
    } else if (keysetSub !== null) {
      request = request.or(keysetSub.slice(3, -1));
    }

    const { data, error } = await request
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(params.fetchLimit);
    requireNoQueryError(error);

    return parseRows(CustomerRowSchema, data).map((raw) => {
      const row = toRow(raw);
      return { row, cursor: { createdAt: row.createdAt, id: row.id } };
    });
  }

  async getCustomer(tenantId: string, customerId: string): Promise<CustomerRow | null> {
    const { data, error } = await this.client
      .from("customers")
      .select("id,name,phone,email,created_at")
      .eq("tenant_id", tenantId)
      .eq("id", customerId)
      .maybeSingle();
    requireNoQueryError(error);
    if (data === null) return null;
    return toRow(CustomerRowSchema.parse(data));
  }

  async findByNormalizedPhone(
    tenantId: string,
    normalizedPhone: string,
  ): Promise<CustomerRow | null> {
    const { data, error } = await this.client
      .from("customers")
      .select("id,name,phone,email,created_at")
      .eq("tenant_id", tenantId)
      .eq("normalized_phone", normalizedPhone)
      .limit(1)
      .maybeSingle();
    requireNoQueryError(error);
    if (data === null) return null;
    return toRow(CustomerRowSchema.parse(data));
  }

  async aggregatesFor(
    tenantId: string,
    customerIds: readonly string[],
  ): Promise<Map<string, CustomerAggregate>> {
    const result = new Map<string, CustomerAggregate>();
    if (customerIds.length === 0) return result;
    const { data, error } = await this.client
      .from("orders")
      .select("customer_id,total_minor,currency,placed_at")
      .eq("tenant_id", tenantId)
      .eq("status", "placed")
      .in("customer_id", [...customerIds]);
    requireNoQueryError(error);

    // Aggregate PLACED orders per customer in memory: count, lifetime spend, most-recent order + its
    // currency. The page is small (<= limit customers) so this is a single bounded query.
    for (const raw of parseRows(AggregateRowSchema, data)) {
      const placedAt = normalizeTimestampUtc(raw.placed_at);
      const current = result.get(raw.customer_id);
      const spent = toSafeInteger(raw.total_minor);
      if (current === undefined) {
        result.set(raw.customer_id, {
          orderCount: 1,
          totalSpentMinor: spent,
          lastOrderAt: placedAt,
          currency: raw.currency,
          outstandingMinor: 0,
        });
      } else {
        const newer = current.lastOrderAt === null || placedAt > current.lastOrderAt;
        result.set(raw.customer_id, {
          orderCount: current.orderCount + 1,
          totalSpentMinor: current.totalSpentMinor + spent,
          lastOrderAt: newer ? placedAt : current.lastOrderAt,
          currency: newer ? raw.currency : current.currency,
          outstandingMinor: current.outstandingMinor,
        });
      }
    }

    // Overlay installment outstanding (sum of owed-minus-paid-at-sale, less later payments) per customer.
    // A customer can carry a balance with zero placed-order aggregate, so seed any missing entries.
    const outstanding = await this.outstandingFor(tenantId, customerIds);
    for (const [customerId, owed] of outstanding) {
      const current = result.get(customerId);
      if (current === undefined) {
        result.set(customerId, {
          orderCount: 0,
          totalSpentMinor: 0,
          lastOrderAt: null,
          currency: null,
          outstandingMinor: owed,
        });
      } else {
        result.set(customerId, { ...current, outstandingMinor: owed });
      }
    }
    return result;
  }

  // Aggregate installment balance per customer: Σ(total - initial_paid) across sale debts, minus
  // Σ(customer payments), floored at zero. Two bounded queries over the requested customer ids.
  private async outstandingFor(
    tenantId: string,
    customerIds: readonly string[],
  ): Promise<Map<string, number>> {
    const owed = new Map<string, number>();
    if (customerIds.length === 0) return owed;
    const debtRowSchema = z.object({
      customer_id: z.string().uuid(),
      total_minor: z.union([z.number(), z.string()]),
      initial_paid_minor: z.union([z.number(), z.string()]),
    });
    const paymentRowSchema = z.object({
      customer_id: z.string().uuid(),
      amount_minor: z.union([z.number(), z.string()]),
    });
    const { data: debts, error: debtError } = await this.client
      .from("customer_sale_debts")
      .select("customer_id,total_minor,initial_paid_minor")
      .eq("tenant_id", tenantId)
      .in("customer_id", [...customerIds]);
    requireNoQueryError(debtError);
    const { data: payments, error: payError } = await this.client
      .from("customer_payments")
      .select("customer_id,amount_minor")
      .eq("tenant_id", tenantId)
      .in("customer_id", [...customerIds]);
    requireNoQueryError(payError);

    for (const row of parseRows(debtRowSchema, debts)) {
      owed.set(
        row.customer_id,
        (owed.get(row.customer_id) ?? 0) +
          toSafeInteger(row.total_minor) -
          toSafeInteger(row.initial_paid_minor),
      );
    }
    for (const row of parseRows(paymentRowSchema, payments)) {
      owed.set(row.customer_id, (owed.get(row.customer_id) ?? 0) - toSafeInteger(row.amount_minor));
    }
    for (const [id, value] of owed) owed.set(id, Math.max(0, value));
    return owed;
  }

  async listCustomerOrders(params: CustomerOrdersParams): Promise<CustomerOrderListRow[]> {
    let request = this.client
      .from("orders")
      .select("id,order_number,channel,status,brand_id,branch_id,currency,total_minor,placed_at")
      .eq("tenant_id", params.tenantId)
      .eq("customer_id", params.customerId);
    if (params.cursor !== null) {
      request = request.or(
        `placed_at.lt.${params.cursor.placedAt},and(placed_at.eq.${params.cursor.placedAt},id.lt.${params.cursor.id})`,
      );
    }
    const { data, error } = await request
      .order("placed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(params.fetchLimit);
    requireNoQueryError(error);

    return parseRows(OrderRowSchema, data).map((row) => ({
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

export interface SupabaseCustomersReadRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseCustomersReadRepository(
  configuration: SupabaseCustomersReadRepositoryConfiguration,
): SupabaseCustomersReadRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseCustomersReadRepository(client);
}
