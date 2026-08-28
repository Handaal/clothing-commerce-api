import { z } from "zod";

/**
 * Phase 2E fulfillment contracts. These describe the caller-provided fields of each command only.
 * Tenant, actor Membership, the derived variant of each line, the inventory operation, timestamps, and
 * all authoritative values are derived server-side from the verified authorization context and the
 * persisted Order/OrderLines; they are never part of a caller DTO. In particular a caller never supplies
 * tenantId, variantId, branchId, brandId, channel, actorMembershipId, an inventory delta/type, a status,
 * price/totals, or a fulfilled-quantity snapshot.
 */

// Fulfilled quantities are whole clothing pieces. The database stores bigint; JavaScript safe integers
// cover every realistic retail quantity and anything larger is rejected rather than silently truncated.
const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

const UuidSchema = z.string().uuid();
const PositiveQuantitySchema = z.number().int().positive().max(MAX_QUANTITY);

// A creation idempotency key is caller-supplied and stable per logical intent; the service never
// generates one. Length is bounded consistently with orders/inventory so a key cannot become an
// unbounded storage/index burden.
const IdempotencyKeySchema = z.string().trim().min(1).max(200);

const FulfillmentLineInputSchema = z
  .object({
    orderLineId: UuidSchema,
    quantity: PositiveQuantitySchema,
  })
  .strict();

export const CreateFulfillmentInputSchema = z
  .object({
    orderId: UuidSchema,
    inventoryLocationId: UuidSchema,
    lines: z.array(FulfillmentLineInputSchema).min(1),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, line] of value.lines.entries()) {
      if (seen.has(line.orderLineId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "an order line may appear at most once in a fulfillment",
          path: ["lines", index, "orderLineId"],
        });
      }
      seen.add(line.orderLineId);
    }
  });

export const GetFulfillmentInputSchema = z.object({ fulfillmentId: UuidSchema }).strict();
export const GetOrderFulfillmentsInputSchema = z.object({ orderId: UuidSchema }).strict();
export const GetOrderFulfillmentSummaryInputSchema = z.object({ orderId: UuidSchema }).strict();

export type CreateFulfillmentInput = z.infer<typeof CreateFulfillmentInputSchema>;
export type GetFulfillmentInput = z.infer<typeof GetFulfillmentInputSchema>;
export type GetOrderFulfillmentsInput = z.infer<typeof GetOrderFulfillmentsInputSchema>;
export type GetOrderFulfillmentSummaryInput = z.infer<typeof GetOrderFulfillmentSummaryInputSchema>;

/**
 * The two authorities a NEW Fulfillment requires. A generic fulfillment.create permission deliberately
 * does not exist: fulfillment is the composition of a COMMERCIAL authority (orders.fulfill, against the
 * persisted Order's brand/branch) and a CUSTODY authority (inventory.issue, against the
 * InventoryLocation). Reads use the commercial read authority only.
 */
export const FulfillmentPermission = {
  /** Commercial authority to fulfill an Order, against the persisted Order brand/branch. */
  fulfill: "orders.fulfill",
  /** Custody authority to issue stock, against the InventoryLocation. */
  issue: "inventory.issue",
  /** Commercial read authority, against the persisted Order brand/branch. */
  read: "orders.read",
} as const;

export type OrderChannel = "pos" | "online";

/**
 * Canonical client intent used for the idempotency fingerprint and the replay preflight. It contains
 * only client-controlled business inputs (order, location, and ordered order-line/quantity lines),
 * never the derived variant, actor, timestamps, or any inventory detail.
 */
export interface FulfillmentClientIntent {
  readonly orderId: string;
  readonly inventoryLocationId: string;
  readonly lines: ReadonlyArray<{ readonly orderLineId: string; readonly quantity: number }>;
}

/**
 * Routing-only descriptor from the replay preflight. Never carries quantities or movement detail. The
 * commercial routing (channel/brandId/branchId) comes from the persisted Order and is used to authorize
 * BOTH authorities on replay against immutable resources.
 */
export type FulfillmentReplayPreflightResult =
  | { readonly kind: "none" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "replay";
      readonly fulfillmentId: string;
      readonly orderId: string;
      readonly inventoryLocationId: string;
      readonly channel: OrderChannel;
      readonly brandId: string;
      readonly branchId: string | null;
    };

/** Routing-only descriptor for an Order, used to authorize a create/read before loading anything. */
export interface OrderRouting {
  readonly orderId: string;
  readonly channel: OrderChannel;
  readonly brandId: string;
  readonly branchId: string | null;
}

/** Routing-only descriptor for a Fulfillment (its Order's commercial routing), used to authorize reads. */
export interface FulfillmentRouting {
  readonly fulfillmentId: string;
  readonly orderId: string;
  readonly channel: OrderChannel;
  readonly brandId: string;
  readonly branchId: string | null;
}

export interface FulfillmentLineResult {
  readonly id: string;
  readonly lineNumber: number;
  readonly orderLineId: string;
  readonly variantId: string;
  readonly quantity: number;
}

export interface FulfillmentResult {
  readonly id: string;
  readonly orderId: string;
  readonly inventoryLocationId: string;
  readonly inventoryOperationId: string;
  readonly actorMembershipId: string | null;
  readonly fulfilledAt: string;
  readonly createdAt: string;
  readonly lines: readonly FulfillmentLineResult[];
}

/** Per-order-line fulfillment progress, computed from FulfillmentLines (never persisted as a projection). */
export type FulfillmentProgressStatus = "unfulfilled" | "partially_fulfilled" | "fulfilled";

export interface OrderFulfillmentLineSummary {
  readonly orderLineId: string;
  readonly variantId: string;
  readonly orderedQuantity: number;
  readonly fulfilledQuantity: number;
  readonly status: FulfillmentProgressStatus;
}

export interface OrderFulfillmentSummary {
  readonly orderId: string;
  readonly status: FulfillmentProgressStatus;
  readonly lines: readonly OrderFulfillmentLineSummary[];
  readonly fulfillmentIds: readonly string[];
}
