import { z } from "zod";

import { NonNegativeIntegerSchema, PositiveIntegerSchema } from "../common/serialization";
import { paginated } from "../common/pagination";

/**
 * Inventory management DTO. A single joined query projects the on-hand balance together with the
 * variant/product display data a manager needs. `version` is the authoritative optimistic-concurrency
 * token of the persisted balance row: a client reads it here and passes it back as `expectedVersion`
 * on an adjustment. The movement ledger, operation metadata, and signed deltas are never exposed.
 */

const UuidSchema = z.string().uuid();

export const InventoryBalanceSchema = z.object({
  inventoryLocationId: UuidSchema,
  variantId: UuidSchema,
  productId: UuidSchema,
  // Owning brand, so the client can group/filter stock without a second product read.
  brandId: UuidSchema,
  productName: z.string(),
  sku: z.string(),
  onHand: NonNegativeIntegerSchema,
  // Current cost basis and active selling price in minor units; null when unset for the variant.
  // Together with onHand these drive the inventory valuation (total stock value / total selling value).
  unitCostMinor: NonNegativeIntegerSchema.nullable(),
  sellingPriceMinor: NonNegativeIntegerSchema.nullable(),
  // Authoritative persisted balance version (0 for a key with no history). This is the same value
  // adjustInventory guards against; it is never a client-manufactured or onHand-derived number.
  version: NonNegativeIntegerSchema,
});

export type InventoryBalance = z.infer<typeof InventoryBalanceSchema>;

export const InventoryListResponseSchema = paginated(InventoryBalanceSchema);
export type InventoryListResponse = z.infer<typeof InventoryListResponseSchema>;

/**
 * Phase 2G inventory WRITE contracts. Each request carries only the business fields the operation needs;
 * the idempotency key is supplied out-of-band via the required Idempotency-Key header (see
 * src/http/management-route.ts) so it stays out of the payload the ledger fingerprints, and the tenant,
 * actor membership, and authorization context are derived server-side. `.strict()` rejects unknown keys
 * so a caller cannot smuggle internal fields. Responses mirror the domain result projections exactly;
 * no ledger movement, signed delta, or operation metadata beyond the operation id is ever exposed.
 */

// An operator note is a narrow, tenant-visible free-text field, never a metadata blob or secret store.
const NoteSchema = z.string().trim().min(1).max(500);

export const ReceiveInventoryRequestSchema = z
  .object({
    variantId: UuidSchema,
    inventoryLocationId: UuidSchema,
    supplierId: z.string().uuid().optional(),
    supplierReference: z.string().trim().min(1).max(200).optional(),
    quantity: PositiveIntegerSchema,
    note: NoteSchema.optional(),
  })
  .strict();
export type ReceiveInventoryRequest = z.infer<typeof ReceiveInventoryRequestSchema>;

export const AdjustInventoryRequestSchema = z
  .object({
    variantId: UuidSchema,
    inventoryLocationId: UuidSchema,
    // A physical recount reconciles the balance to this observed on-hand, guarded by the version it was
    // counted against (optimistic concurrency); a stale version is a safe 409, never a blind overwrite.
    countedQuantity: NonNegativeIntegerSchema,
    expectedVersion: NonNegativeIntegerSchema,
    note: NoteSchema.optional(),
  })
  .strict();
export type AdjustInventoryRequest = z.infer<typeof AdjustInventoryRequestSchema>;

export const TransferInventoryRequestSchema = z
  .object({
    variantId: UuidSchema,
    sourceInventoryLocationId: UuidSchema,
    destinationInventoryLocationId: UuidSchema,
    quantity: PositiveIntegerSchema,
    note: NoteSchema.optional(),
  })
  .strict();
export type TransferInventoryRequest = z.infer<typeof TransferInventoryRequestSchema>;

/**
 * Receipt result. record_operation returns only the operation id, so onHand/version are the CURRENT
 * observed balance read after commit, not an atomic before/after snapshot of this receipt.
 */
export const ReceiveInventoryResponseSchema = z.object({
  supplierId: UuidSchema.optional(),
  supplierReference: z.string().optional(),
  operationId: UuidSchema,
  variantId: UuidSchema,
  inventoryLocationId: UuidSchema,
  observedOnHand: NonNegativeIntegerSchema,
  observedVersion: NonNegativeIntegerSchema,
});
export type ReceiveInventoryResponse = z.infer<typeof ReceiveInventoryResponseSchema>;

/**
 * Count-adjustment result. These values are AUTHORITATIVE at the mutation instant (computed under the
 * balance-row lock). A deterministic no-op recount still persists an operation, so `changed` may be
 * false with previousOnHand === newOnHand.
 */
export const AdjustInventoryResponseSchema = z.object({
  operationId: UuidSchema,
  changed: z.boolean(),
  variantId: UuidSchema,
  inventoryLocationId: UuidSchema,
  previousOnHand: NonNegativeIntegerSchema,
  newOnHand: NonNegativeIntegerSchema,
  version: NonNegativeIntegerSchema,
});
export type AdjustInventoryResponse = z.infer<typeof AdjustInventoryResponseSchema>;

const TransferSideSchema = z.object({
  inventoryLocationId: UuidSchema,
  observedOnHand: NonNegativeIntegerSchema,
  observedVersion: NonNegativeIntegerSchema,
});

/**
 * Transfer result. One atomic operation moves stock from source to destination; both sides are reported
 * as post-commit observed state (not atomic before/after snapshots).
 */
export const TransferInventoryResponseSchema = z.object({
  operationId: UuidSchema,
  variantId: UuidSchema,
  source: TransferSideSchema,
  destination: TransferSideSchema,
});
export type TransferInventoryResponse = z.infer<typeof TransferInventoryResponseSchema>;
