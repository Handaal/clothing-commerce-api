import { z } from "zod";

import { NonNegativeIntegerSchema } from "../common/serialization";
import { paginated } from "../common/pagination";

/**
 * Inventory management DTO. A single joined query projects the on-hand balance together with the
 * variant/product display data a manager needs. The internal projection's version, movement ledger,
 * operation metadata, and signed deltas are never exposed.
 */

const UuidSchema = z.string().uuid();

export const InventoryBalanceSchema = z.object({
  inventoryLocationId: UuidSchema,
  variantId: UuidSchema,
  productName: z.string(),
  sku: z.string(),
  onHand: NonNegativeIntegerSchema,
});

export type InventoryBalance = z.infer<typeof InventoryBalanceSchema>;

export const InventoryListResponseSchema = paginated(InventoryBalanceSchema);
export type InventoryListResponse = z.infer<typeof InventoryListResponseSchema>;
