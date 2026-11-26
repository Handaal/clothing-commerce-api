import { z } from "zod";

import { PositiveIntegerSchema } from "../common/serialization";

/**
 * Catalog sales (Storefront merchandising). A sale is a per-unit ONLINE price reduction — a percentage
 * (basis points) or a fixed minor amount in one currency — scoped to every product, one collection, or
 * selected products, with an optional start/end window. When several sales match a product the lowest
 * resulting price wins (never stacked). The Storefront shows the reduced price with the original struck
 * through; checkout charges the reduced price. POS pricing is unaffected. Authorized by
 * promotions.read / promotions.manage.
 */
export const SaleStatusSchema = z.enum(["active", "inactive"]);
export const SaleBenefitTypeSchema = z.enum(["percentage", "fixed_amount"]);
export const SaleScopeSchema = z.enum(["all", "collection", "products"]);

const PercentBpSchema = z.number().int().min(1).max(10000);
const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
const DateTimeSchema = z.string().datetime({ offset: true });

export const SaleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: SaleStatusSchema,
  benefitType: SaleBenefitTypeSchema,
  benefitPercentBp: z.number().int().nullable(),
  benefitAmountMinor: z.number().int().nullable(),
  benefitCurrency: z.string().nullable(),
  scope: SaleScopeSchema,
  collectionId: z.uuid().nullable(),
  productIds: z.array(z.uuid()),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SaleListResponseSchema = z.object({ items: z.array(SaleSchema) });

export const DeleteSaleResponseSchema = z.object({ id: z.uuid(), deleted: z.literal(true) });

type SaleShapeInput = {
  benefitType?: string;
  benefitPercentBp?: unknown;
  benefitAmountMinor?: unknown;
  benefitCurrency?: unknown;
  scope?: string;
  collectionId?: unknown;
  productIds?: unknown[];
  startsAt?: string | null;
  endsAt?: string | null;
};

function saleShapeRefine(value: SaleShapeInput, ctx: z.RefinementCtx, partial: boolean) {
  if (value.benefitType === "percentage" && value.benefitPercentBp == null && !partial) {
    ctx.addIssue({ code: "custom", message: "percentage sale requires benefitPercentBp" });
  }
  if (
    value.benefitType === "fixed_amount" &&
    (value.benefitAmountMinor == null || value.benefitCurrency == null) &&
    !partial
  ) {
    ctx.addIssue({
      code: "custom",
      message: "fixed_amount sale requires benefitAmountMinor and benefitCurrency",
    });
  }
  if (value.scope === "collection" && value.collectionId == null && !partial) {
    ctx.addIssue({ code: "custom", message: "collection sale requires collectionId" });
  }
  if (value.scope === "products" && (!value.productIds || value.productIds.length === 0)) {
    if (!partial || value.productIds !== undefined) {
      ctx.addIssue({ code: "custom", message: "products sale requires at least one productId" });
    }
  }
  if (value.startsAt && value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    ctx.addIssue({ code: "custom", message: "endsAt must be after startsAt" });
  }
}

const saleFields = {
  name: z.string().trim().min(1).max(200),
  benefitType: SaleBenefitTypeSchema,
  benefitPercentBp: PercentBpSchema.optional(),
  benefitAmountMinor: PositiveIntegerSchema.optional(),
  benefitCurrency: CurrencyCodeSchema.optional(),
  scope: SaleScopeSchema,
  collectionId: z.uuid().optional(),
  productIds: z.array(z.uuid()).max(500).optional(),
  startsAt: DateTimeSchema.nullable().optional(),
  endsAt: DateTimeSchema.nullable().optional(),
};

export const CreateSaleRequestSchema = z
  .object({ ...saleFields, status: SaleStatusSchema.optional() })
  .strict()
  .superRefine((value, ctx) => saleShapeRefine(value, ctx, false));

// Every field is editable (sales carry no sale-time history; orders snapshot the charged price).
export const UpdateSaleRequestSchema = z
  .object(saleFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.")
  .superRefine((value, ctx) => saleShapeRefine(value, ctx, true));

export const SetSaleStatusRequestSchema = z.object({ status: SaleStatusSchema }).strict();

export type SaleStatus = z.infer<typeof SaleStatusSchema>;
export type SaleBenefitType = z.infer<typeof SaleBenefitTypeSchema>;
export type SaleScope = z.infer<typeof SaleScopeSchema>;
export type Sale = z.infer<typeof SaleSchema>;
export type SaleListResponse = z.infer<typeof SaleListResponseSchema>;
export type DeleteSaleResponse = z.infer<typeof DeleteSaleResponseSchema>;
export type CreateSaleRequest = z.infer<typeof CreateSaleRequestSchema>;
export type UpdateSaleRequest = z.infer<typeof UpdateSaleRequestSchema>;
export type SetSaleStatusRequest = z.infer<typeof SetSaleStatusRequestSchema>;
