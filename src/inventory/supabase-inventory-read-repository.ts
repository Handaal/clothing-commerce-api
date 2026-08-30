import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { toSafeInteger } from "../management/db-serialization";
import type {
  InventoryListQuery,
  InventoryListRow,
  InventoryReadRepository,
} from "./inventory-read-repository";

const IdRowSchema = z.object({ id: z.string().uuid() });

// One joined statement: the on-hand balance plus the variant SKU and product name. The nested shape is
// PostgREST embedding across the (tenant_id, variant_id) and (tenant_id, product_id) composite FKs.
const BalanceListRowSchema = z.object({
  inventory_location_id: z.string().uuid(),
  variant_id: z.string().uuid(),
  on_hand_quantity: z.union([z.number(), z.string()]),
  product_variants: z.object({
    sku: z.string(),
    products: z.object({ name: z.string() }),
  }),
});

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error("Inventory read row failed validation.");
  }
  return parsed.data;
}

function requireNoQueryError(error: unknown): void {
  if (error) {
    throw new Error("An unexpected inventory read query error occurred.");
  }
}

export class SupabaseInventoryReadRepository implements InventoryReadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async inventoryLocationExistsInTenant(
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from("inventory_locations")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", inventoryLocationId)
      .limit(1);
    requireNoQueryError(error);
    return parseRows(IdRowSchema, data).length === 1;
  }

  async listBalances(query: InventoryListQuery): Promise<InventoryListRow[]> {
    let request = this.client
      .from("inventory_balances")
      .select(
        "inventory_location_id,variant_id,on_hand_quantity,product_variants!inner(sku,products!inner(name))",
      )
      .eq("tenant_id", query.tenantId);

    // Visibility predicate FIRST (before order/cursor/limit).
    if (!query.visibility.tenantWide) {
      request = request.in("inventory_location_id", [...query.visibility.locationIds]);
    }
    if (query.filters.inventoryLocationId !== undefined) {
      request = request.eq("inventory_location_id", query.filters.inventoryLocationId);
    }
    if (query.filters.variantId !== undefined) {
      request = request.eq("variant_id", query.filters.variantId);
    }
    if (query.cursor !== null) {
      const { inventoryLocationId, variantId } = query.cursor;
      request = request.or(
        `inventory_location_id.gt.${inventoryLocationId},and(inventory_location_id.eq.${inventoryLocationId},variant_id.gt.${variantId})`,
      );
    }

    const { data, error } = await request
      .order("inventory_location_id", { ascending: true })
      .order("variant_id", { ascending: true })
      .limit(query.fetchLimit);
    requireNoQueryError(error);

    return parseRows(BalanceListRowSchema, data).map((row) => ({
      balance: {
        inventoryLocationId: row.inventory_location_id,
        variantId: row.variant_id,
        productName: row.product_variants.products.name,
        sku: row.product_variants.sku,
        onHand: toSafeInteger(row.on_hand_quantity),
      },
      cursor: {
        inventoryLocationId: row.inventory_location_id,
        variantId: row.variant_id,
      },
    }));
  }
}

export interface SupabaseInventoryReadRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseInventoryReadRepository(
  configuration: SupabaseInventoryReadRepositoryConfiguration,
): SupabaseInventoryReadRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseInventoryReadRepository(client);
}
