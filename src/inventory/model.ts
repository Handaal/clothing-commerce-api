import { z } from "zod";

/**
 * Phase 2C inventory operation contracts. These describe the caller-provided fields of each command
 * only. Tenant, actor Membership, and the authorization context are derived server-side from the
 * verified authorization context and are never part of a caller DTO (see inventory-service.ts).
 */

// Discrete clothing stock is integer pieces. The ledger stores bigint; JavaScript safe integers cover
// every realistic retail quantity, and anything larger is rejected rather than silently truncated.
const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

const UuidSchema = z.string().uuid();
const PositiveQuantitySchema = z.number().int().positive().max(MAX_QUANTITY);
const NonNegativeQuantitySchema = z.number().int().min(0).max(MAX_QUANTITY);
const VersionSchema = z.number().int().min(0).max(MAX_QUANTITY);

// A mutation idempotency key is caller-supplied and stable per logical intent; the service never
// generates one. Length is bounded so a key cannot become an unbounded storage/index burden.
const IdempotencyKeySchema = z.string().trim().min(1).max(200);

// Optional operator note. Narrow and tenant-visible by design; not a metadata blob. Callers must not
// place secrets here (documented in inventory-operations.md).
const NoteSchema = z.string().trim().min(1).max(500);

export const GetInventoryBalanceInputSchema = z
  .object({
    variantId: UuidSchema,
    inventoryLocationId: UuidSchema,
  })
  .strict();

export const SetOpeningStockInputSchema = z
  .object({
    variantId: UuidSchema,
    inventoryLocationId: UuidSchema,
    quantity: PositiveQuantitySchema,
    idempotencyKey: IdempotencyKeySchema,
    note: NoteSchema.optional(),
  })
  .strict();

export const AdjustInventoryInputSchema = z
  .object({
    variantId: UuidSchema,
    inventoryLocationId: UuidSchema,
    countedQuantity: NonNegativeQuantitySchema,
    expectedVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    note: NoteSchema.optional(),
  })
  .strict();

export const ReceiveInventoryInputSchema = z
  .object({
    variantId: UuidSchema,
    inventoryLocationId: UuidSchema,
    supplierId: z.string().uuid().optional(),
    supplierReference: z.string().trim().min(1).max(200).optional(),
    quantity: PositiveQuantitySchema,
    idempotencyKey: IdempotencyKeySchema,
    note: NoteSchema.optional(),
  })
  .strict();

export const IssueInventoryInputSchema = z
  .object({
    variantId: UuidSchema,
    inventoryLocationId: UuidSchema,
    quantity: PositiveQuantitySchema,
    idempotencyKey: IdempotencyKeySchema,
    note: NoteSchema.optional(),
  })
  .strict();

export const TransferInventoryInputSchema = z
  .object({
    variantId: UuidSchema,
    sourceInventoryLocationId: UuidSchema,
    destinationInventoryLocationId: UuidSchema,
    quantity: PositiveQuantitySchema,
    idempotencyKey: IdempotencyKeySchema,
    note: NoteSchema.optional(),
  })
  .strict();

export type GetInventoryBalanceInput = z.infer<typeof GetInventoryBalanceInputSchema>;
export type SetOpeningStockInput = z.infer<typeof SetOpeningStockInputSchema>;
export type AdjustInventoryInput = z.infer<typeof AdjustInventoryInputSchema>;
export type ReceiveInventoryInput = z.infer<typeof ReceiveInventoryInputSchema>;
export type IssueInventoryInput = z.infer<typeof IssueInventoryInputSchema>;
export type TransferInventoryInput = z.infer<typeof TransferInventoryInputSchema>;

/** Permission keys enforced by the Phase 2C inventory service (resource.action, platform-global). */
export const InventoryPermission = {
  read: "inventory.read",
  adjust: "inventory.adjust",
  receive: "inventory.receive",
  issue: "inventory.issue",
  transfer: "inventory.transfer",
} as const;

/** Lifecycle statuses read from the merged catalog/org schemas (source of truth). */
export type VariantStatus = "draft" | "active" | "archived";
export type InventoryLocationStatus = "active" | "inactive" | "archived";

export interface VariantState {
  readonly status: VariantStatus;
}

export interface InventoryLocationState {
  readonly status: InventoryLocationStatus;
  readonly isReceivingEnabled: boolean;
  readonly isTransferOriginEnabled: boolean;
  readonly isTransferDestinationEnabled: boolean;
}

export interface StockKey {
  readonly tenantId: string;
  readonly variantId: string;
  readonly inventoryLocationId: string;
}

export interface InventoryBalanceResult {
  readonly variantId: string;
  readonly inventoryLocationId: string;
  readonly onHand: number;
  readonly version: number;
  readonly exists: boolean;
}

/**
 * Result of an opening or count-adjustment mutation. These values are AUTHORITATIVE at the mutation
 * instant: the database function computes and returns them while holding the balance-row lock, so
 * previousOnHand/newOnHand/version reflect exactly this operation and no other. operationId is always
 * present — a deterministic no-op count adjustment still persists an operation envelope (with no
 * movement and an unchanged balance), so changed=false with previousOnHand === newOnHand.
 */
export interface InventoryMutationResult {
  readonly operationId: string;
  readonly changed: boolean;
  readonly variantId: string;
  readonly inventoryLocationId: string;
  readonly previousOnHand: number;
  readonly newOnHand: number;
  readonly version: number;
}

/**
 * Result of a receipt or issue. Phase 2B record_operation returns only the operation id, so the
 * balance is read AFTER commit. observedOnHand/observedVersion are therefore the current observed
 * state, which under concurrency may already include later committed operations — they are explicitly
 * NOT an atomic before/after snapshot of this operation (see inventory-operations.md). Only the
 * operation having been recorded is guaranteed.
 */
export interface InventoryObservedMutationResult {
  readonly operationId: string;
  readonly changed: true;
  readonly variantId: string;
  readonly inventoryLocationId: string;
  readonly observedOnHand: number;
  readonly observedVersion: number;
}

/** One side of a transfer, reported as post-commit observed state (not an atomic snapshot). */
export interface InventoryTransferSide {
  readonly inventoryLocationId: string;
  readonly observedOnHand: number;
  readonly observedVersion: number;
}

export interface InventoryTransferResult {
  readonly operationId: string;
  readonly variantId: string;
  readonly source: InventoryTransferSide;
  readonly destination: InventoryTransferSide;
}
