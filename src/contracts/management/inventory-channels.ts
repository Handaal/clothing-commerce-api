import { z } from "zod";

import { NonNegativeIntegerSchema, SafeIntegerSchema } from "../common/serialization";

/**
 * ADR-042 Website/POS channel stock contracts (management). Channels PARTITION the canonical on-hand of a
 * (location, variant) into website / pos / unallocated buckets; they never create stock. Website reserved
 * is derived live from open website reservations. Mode is per location: legacy (default, no channels),
 * shadow (maintained, never blocks a sale), enforced (not reachable through this API).
 */

const UuidSchema = z.string().uuid();

export const ChannelStockModeSchema = z.enum(["legacy", "shadow", "enforced"]);
export type ChannelStockMode = z.infer<typeof ChannelStockModeSchema>;

export const InventoryChannelBalanceSchema = z.object({
  variantId: UuidSchema,
  canonicalOnHand: NonNegativeIntegerSchema,
  websiteOnHand: NonNegativeIntegerSchema,
  websiteReserved: NonNegativeIntegerSchema,
  websiteAvailable: NonNegativeIntegerSchema,
  posOnHand: NonNegativeIntegerSchema,
  posReserved: NonNegativeIntegerSchema,
  posAvailable: NonNegativeIntegerSchema,
  unallocatedOnHand: NonNegativeIntegerSchema,
  // canonicalOnHand - (website + pos + unallocated). 0 when the key reconciles; only non-zero in shadow
  // mode after a sale that its channel could not cover. The next split for the variant heals it.
  mismatch: SafeIntegerSchema,
  // True once the variant has appeared in at least one explicit admin split at this location.
  explicitlyAllocated: z.boolean(),
  // ADR-042 §3.5: versions the split screen must send back. balanceVersion changes with every stock
  // movement; allocationVersion changes with every committed split of this variant at this location.
  balanceVersion: NonNegativeIntegerSchema,
  allocationVersion: NonNegativeIntegerSchema,
});
export type InventoryChannelBalance = z.infer<typeof InventoryChannelBalanceSchema>;

export const InventoryChannelStateResponseSchema = z.object({
  inventoryLocationId: UuidSchema,
  mode: ChannelStockModeSchema,
  items: z.array(InventoryChannelBalanceSchema),
});
export type InventoryChannelStateResponse = z.infer<typeof InventoryChannelStateResponseSchema>;

export const InitializeInventoryChannelsRequestSchema = z
  .object({ inventoryLocationId: UuidSchema })
  .strict();
export type InitializeInventoryChannelsRequest = z.infer<
  typeof InitializeInventoryChannelsRequestSchema
>;

export const InitializeInventoryChannelsResponseSchema = z.object({
  inventoryLocationId: UuidSchema,
  mode: ChannelStockModeSchema,
  // false when the location was already initialized (the call is naturally idempotent).
  initialized: z.boolean(),
  allocationRunId: UuidSchema.nullable(),
});
export type InitializeInventoryChannelsResponse = z.infer<
  typeof InitializeInventoryChannelsResponseSchema
>;

export const InventoryChannelAllocationLineSchema = z
  .object({
    variantId: UuidSchema,
    websiteQuantity: NonNegativeIntegerSchema,
    posQuantity: NonNegativeIntegerSchema,
    // Required optimistic guards (ADR-042 §3.5): the balance and allocation versions the admin's screen
    // was built from. A stock movement or another admin's split since then makes the WHOLE request a 409
    // (details carry the current values); nothing is ever overwritten silently.
    expectedBalanceVersion: NonNegativeIntegerSchema,
    expectedAllocationVersion: NonNegativeIntegerSchema,
  })
  .strict();
export type InventoryChannelAllocationLine = z.infer<typeof InventoryChannelAllocationLineSchema>;

export const AllocateInventoryChannelsRequestSchema = z
  .object({
    inventoryLocationId: UuidSchema,
    reason: z.string().trim().min(1).max(500),
    lines: z.array(InventoryChannelAllocationLineSchema).min(1).max(1000),
  })
  .strict()
  .refine(
    (value) => new Set(value.lines.map((line) => line.variantId)).size === value.lines.length,
    {
      message: "Each variant may appear at most once.",
      path: ["lines"],
    },
  );
export type AllocateInventoryChannelsRequest = z.infer<
  typeof AllocateInventoryChannelsRequestSchema
>;

export const AllocateInventoryChannelsResponseSchema = z.object({
  allocationRunId: UuidSchema,
  inventoryLocationId: UuidSchema,
  // Post-commit observed state of every variant in the split.
  items: z.array(InventoryChannelBalanceSchema),
});
export type AllocateInventoryChannelsResponse = z.infer<
  typeof AllocateInventoryChannelsResponseSchema
>;
