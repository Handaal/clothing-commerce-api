import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { toSafeInteger } from "../management/db-serialization";
import type {
  InventoryListQuery,
  InventoryListRow,
  InventoryReadRepository,
} from "./inventory-read-repository";

const IdRowSchema = z.object({ id: z.string().uuid() });

// One joined statement: the on-hand balance plus the variant SKU/cost, the product identity (id, brand,
// name) and the active selling price. The nested shape is PostgREST embedding across the composite FKs;
// variant_prices is a LEFT embed filtered to the active row, so a variant with no price yields an empty
// array (null selling price) rather than dropping the stock row.
const BalanceListRowSchema = z.object({
  inventory_location_id: z.string().uuid(),
  variant_id: z.string().uuid(),
  on_hand_quantity: z.union([z.number(), z.string()]),
  version: z.union([z.number(), z.string()]),
  product_variants: z.object({
    sku: z.string(),
    unit_cost_minor: z.union([z.number(), z.string()]).nullable(),
    products: z.object({ id: z.string().uuid(), brand_id: z.string().uuid(), name: z.string() }),
    variant_prices: z.array(z.object({ amount_minor: z.union([z.number(), z.string()]) })),
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
        "inventory_location_id,variant_id,on_hand_quantity,version,product_variants!inner(sku,unit_cost_minor,products!inner(id,brand_id,name),variant_prices(amount_minor))",
      )
      .eq("tenant_id", query.tenantId)
      // Only the active price row contributes the selling price; archived history is excluded.
      .eq("product_variants.variant_prices.status", "active");

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
        productId: row.product_variants.products.id,
        brandId: row.product_variants.products.brand_id,
        productName: row.product_variants.products.name,
        sku: row.product_variants.sku,
        onHand: toSafeInteger(row.on_hand_quantity),
        unitCostMinor:
          row.product_variants.unit_cost_minor === null
            ? null
            : toSafeInteger(row.product_variants.unit_cost_minor),
        sellingPriceMinor:
          row.product_variants.variant_prices.length === 0
            ? null
            : toSafeInteger(row.product_variants.variant_prices[0].amount_minor),
        version: toSafeInteger(row.version),
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
