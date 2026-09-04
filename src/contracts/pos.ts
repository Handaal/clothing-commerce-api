import { z } from "zod";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common/serialization";

const UuidSchema = z.string().uuid();

export const PosContextRegisterSchema = z.object({
  registerId: UuidSchema,
  registerName: z.string().min(1),
  branchId: UuidSchema,
  branchName: z.string().min(1),
  defaultInventoryLocationId: UuidSchema,
  defaultInventoryLocationName: z.string().min(1),
  sellingCurrency: CurrencySchema,
  canSell: z.literal(true),
});

export const PosContextResponseSchema = z.object({
  registers: z.array(PosContextRegisterSchema),
});

export const CreatePosSaleRequestSchema = z
  .object({
    registerId: UuidSchema,
    expectedTotalMinor: NonNegativeIntegerSchema,
    cashReceivedMinor: NonNegativeIntegerSchema,
    lines: z
      .array(
        z.object({
          variantId: UuidSchema,
          quantity: PositiveIntegerSchema,
        }),
      )
      .min(1),
  })
  .strict();

const PosOrderLineSchema = z.object({
  id: UuidSchema,
  lineNumber: PositiveIntegerSchema,
  variantId: UuidSchema,
  quantity: PositiveIntegerSchema,
  unitPriceMinor: NonNegativeIntegerSchema,
  lineTotalMinor: NonNegativeIntegerSchema,
  productName: z.string(),
  variantName: z.string().nullable(),
  sku: z.string(),
  optionSummary: z.string().nullable(),
});

const PosOrderSchema = z.object({
  id: UuidSchema,
  orderNumber: z.string(),
  channel: z.literal("pos"),
  status: z.literal("placed"),
  brandId: UuidSchema,
  branchId: UuidSchema,
  registerId: UuidSchema,
  currency: CurrencySchema,
  totalMinor: NonNegativeIntegerSchema,
  actorMembershipId: UuidSchema,
  placedAt: IsoDateTimeSchema,
  cancelledAt: z.null(),
  cancelledByMembershipId: z.null(),
  cancellationReason: z.null(),
  notes: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lines: z.array(PosOrderLineSchema).min(1),
});

export const CashPaymentSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  method: z.literal("cash"),
  status: z.literal("captured"),
  currency: CurrencySchema,
  amountMinor: NonNegativeIntegerSchema,
  cashReceivedMinor: NonNegativeIntegerSchema,
  changeMinor: NonNegativeIntegerSchema,
  capturedByMembershipId: UuidSchema,
  capturedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

const PosFulfillmentLineSchema = z.object({
  id: UuidSchema,
  lineNumber: PositiveIntegerSchema,
  orderLineId: UuidSchema,
  variantId: UuidSchema,
  quantity: PositiveIntegerSchema,
});

const PosFulfillmentSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  inventoryLocationId: UuidSchema,
  inventoryOperationId: UuidSchema,
  actorMembershipId: UuidSchema,
  fulfilledAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  lines: z.array(PosFulfillmentLineSchema).min(1),
});

export const CreatePosSaleResponseSchema = z.object({
  saleStatus: z.literal("completed"),
  order: PosOrderSchema,
  payment: CashPaymentSchema,
  fulfillment: PosFulfillmentSchema,
});

export type PosContextResponse = z.infer<typeof PosContextResponseSchema>;
export type CreatePosSaleRequest = z.infer<typeof CreatePosSaleRequestSchema>;
export type CreatePosSaleResponse = z.infer<typeof CreatePosSaleResponseSchema>;
