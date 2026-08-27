import { z } from "zod";

/**
 * Phase 2D order contracts. These describe the caller-provided fields of each command only. Tenant,
 * actor Membership, brand, branch, authoritative prices, and snapshots are derived server-side from
 * the verified authorization context and the catalog; they are never part of a caller DTO.
 */

// Order quantities are whole clothing pieces. The database stores bigint; JavaScript safe integers
// cover every realistic retail quantity and anything larger is rejected rather than silently truncated.
const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

const UuidSchema = z.string().uuid();
const PositiveQuantitySchema = z.number().int().positive().max(MAX_QUANTITY);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

// A creation idempotency key is caller-supplied and stable per logical intent; the service never
// generates one. Length is bounded so a key cannot become an unbounded storage/index burden.
const IdempotencyKeySchema = z.string().trim().min(1).max(200);

// Optional operator note. Narrow and tenant-visible by design; not a metadata blob and never part of
// the idempotency fingerprint. Callers must not place secrets here.
const NoteSchema = z.string().trim().min(1).max(500);

const OrderLineInputSchema = z
  .object({
    variantId: UuidSchema,
    quantity: PositiveQuantitySchema,
  })
  .strict();

export const CreateOrderInputSchema = z
  .object({
    channel: z.enum(["pos", "online"]),
    // POS provenance. The server resolves the branch from this register; a caller never supplies a
    // trusted branchId/brandId/price/actor.
    registerId: UuidSchema.optional(),
    currency: CurrencySchema,
    lines: z.array(OrderLineInputSchema).min(1),
    idempotencyKey: IdempotencyKeySchema,
    notes: NoteSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.channel === "pos" && value.registerId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "registerId is required for pos orders",
        path: ["registerId"],
      });
    }
    if (value.channel === "online" && value.registerId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "registerId is not allowed for online orders",
        path: ["registerId"],
      });
    }
  });

export const CancelOrderInputSchema = z
  .object({
    orderId: UuidSchema,
    reason: NoteSchema.optional(),
  })
  .strict();

export const GetOrderInputSchema = z.object({ orderId: UuidSchema }).strict();
export const GetOrderByNumberInputSchema = z
  .object({ orderNumber: z.string().trim().min(1).max(200) })
  .strict();

export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;
export type CancelOrderInput = z.infer<typeof CancelOrderInputSchema>;
export type GetOrderInput = z.infer<typeof GetOrderInputSchema>;
export type GetOrderByNumberInput = z.infer<typeof GetOrderByNumberInputSchema>;

/** Permission keys enforced by the Phase 2D order service (resource.action, platform-global). */
export const OrderPermission = {
  read: "orders.read",
  create: "orders.create",
  cancel: "orders.cancel",
} as const;

export type OrderChannel = "pos" | "online";
export type OrderStatus = "placed" | "cancelled";

/** Lifecycle statuses read from the merged catalog/org schemas (source of truth). */
export type VariantStatus = "draft" | "active" | "archived";
export type BranchStatus = "active" | "inactive" | "archived";
export type RegisterStatus = "active" | "inactive" | "archived";

/**
 * Canonical client intent used for the idempotency fingerprint and the replay preflight. It contains
 * only client-controlled business inputs, never resolved prices/snapshots/derived brand or branch.
 */
export interface OrderClientIntent {
  readonly channel: OrderChannel;
  readonly currency: string;
  readonly registerId: string | null;
  readonly lines: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
}

/** Routing-only descriptor from the replay preflight. Never carries commercial order data. */
export type ReplayPreflightResult =
  | { readonly kind: "none" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "replay";
      readonly orderId: string;
      readonly channel: OrderChannel;
      readonly brandId: string;
      readonly branchId: string | null;
    };

/** Routing-only descriptor used to authorize a read/cancel before loading the aggregate. */
export interface OrderRouting {
  readonly orderId: string;
  readonly channel: OrderChannel;
  readonly brandId: string;
  readonly branchId: string | null;
}

/** Foundational register context (branch + status) used to bootstrap POS branch authorization. */
export interface RegisterContext {
  readonly branchId: string;
  readonly status: RegisterStatus;
}

/** Catalog state resolved for one requested line at NEW-command time (never on replay). */
export interface OrderLineCatalogState {
  readonly variantId: string;
  readonly productId: string;
  readonly brandId: string;
  readonly variantStatus: VariantStatus;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly optionSummary: string | null;
}

/** A fully server-resolved, authorized order line ready to persist as an immutable snapshot. */
export interface ResolvedOrderLine {
  readonly variantId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly optionSummary: string | null;
}

export interface OrderLineResult {
  readonly id: string;
  readonly lineNumber: number;
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly optionSummary: string | null;
}

export interface OrderResult {
  readonly id: string;
  readonly orderNumber: string;
  readonly channel: OrderChannel;
  readonly status: OrderStatus;
  readonly brandId: string;
  readonly branchId: string | null;
  readonly registerId: string | null;
  readonly currency: string;
  readonly totalMinor: number;
  readonly actorMembershipId: string | null;
  readonly placedAt: string;
  readonly cancelledAt: string | null;
  readonly cancelledByMembershipId: string | null;
  readonly cancellationReason: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly OrderLineResult[];
}
