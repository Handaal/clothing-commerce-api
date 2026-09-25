import { z } from "zod";
import { PageInfoSchema } from "../common/pagination";
import { CurrencySchema, IsoDateTimeSchema, SafeIntegerSchema } from "../common/serialization";

/**
 * Phase 2Q-A reporting DTOs. Operational reporting only — NOT accounting, BI, OLAP, forecasting, or
 * profitability. Frozen V1 definitions (see docs/reporting/reporting-core.md and ADR-038):
 *
 *  - Every report echoes its resolved `period` (tenant timezone + half-open UTC [fromInclusive,
 *    toExclusive)). Inputs are inclusive tenant-local calendar dates resolved via tenants.default_timezone.
 *  - Every monetary result is grouped by currency; currencies are NEVER summed together.
 *  - Sales KPIs are computed over Orders currently status='placed'. Gross = Σ gross_subtotal, discount =
 *    Σ discount_total, net = Σ total, AOV = round(net / orderCount) (null when orderCount = 0). A later
 *    cancel/return never rewrites historical sales, and net-after-returns is not a primary KPI.
 *  - Returns/refunds are separate event-period metrics; pending refunds are the current obligation.
 *
 * Several list views share one endpoint via a `view`/`level` selector, so the per-item shapes carry
 * view-specific optional fields; the fields present for a given `view` are documented per report.
 */

/** Money in minor units (server sums fit the JS safe-integer range). */
const MinorSchema = SafeIntegerSchema;
const QuantitySchema = SafeIntegerSchema;

export const ReportPeriodSchema = z.object({
  timezone: z.string(),
  fromInclusive: IsoDateTimeSchema,
  toExclusive: IsoDateTimeSchema,
});
export type ReportPeriod = z.infer<typeof ReportPeriodSchema>;

// ---- Summary ----
export const SalesCurrencyKpiSchema = z.object({
  currency: CurrencySchema,
  grossSalesMinor: MinorSchema,
  discountsMinor: MinorSchema,
  netSalesMinor: MinorSchema,
  orderCount: SafeIntegerSchema,
  averageOrderValueMinor: MinorSchema.nullable(),
});
export const ReturnsCurrencyKpiSchema = z.object({
  currency: CurrencySchema,
  acceptedReturnedValueMinor: MinorSchema,
  returnCount: SafeIntegerSchema,
});
export const RefundsCurrencyKpiSchema = z.object({
  currency: CurrencySchema,
  succeededRefundMinor: MinorSchema,
  pendingRefundMinor: MinorSchema,
});
export const ReportSummaryResponseSchema = z.object({
  period: ReportPeriodSchema,
  salesByCurrency: z.array(SalesCurrencyKpiSchema),
  returns: z.object({
    byCurrency: z.array(ReturnsCurrencyKpiSchema),
    refundsByCurrency: z.array(RefundsCurrencyKpiSchema),
  }),
  stock: z.object({
    totalOnHandQuantity: QuantitySchema,
    variantCount: SafeIntegerSchema,
    locationCount: SafeIntegerSchema,
  }),
  inventoryAsOf: IsoDateTimeSchema,
});
export type ReportSummaryResponse = z.infer<typeof ReportSummaryResponseSchema>;

// ---- Sales ----
export const SalesViewSchema = z.enum([
  "trend",
  "channel",
  "brand",
  "pos_branch",
  "pos_register",
  "pos_operator",
]);
export const SalesBucketSchema = z.enum(["day", "week", "month"]);
/**
 * One sales row. `currency` and the four metrics are always present; the dimension fields depend on
 * `view`: trend→bucketStart; channel→channel; brand→brandId/brandName; pos_branch→branchId/branchName;
 * pos_register→registerId/registerName/branchId; pos_operator→membershipId/operatorName.
 */
export const SalesReportItemSchema = z.object({
  currency: CurrencySchema,
  grossSalesMinor: MinorSchema,
  discountsMinor: MinorSchema,
  netSalesMinor: MinorSchema,
  orderCount: SafeIntegerSchema,
  bucketStart: z.string().optional(),
  channel: z.enum(["pos", "online"]).optional(),
  brandId: z.string().uuid().optional(),
  brandName: z.string().optional(),
  branchId: z.string().uuid().nullable().optional(),
  branchName: z.string().optional(),
  registerId: z.string().uuid().optional(),
  registerName: z.string().optional(),
  membershipId: z.string().uuid().nullable().optional(),
  operatorName: z.string().nullable().optional(),
});
export type SalesView = z.infer<typeof SalesViewSchema>;
export type SalesBucket = z.infer<typeof SalesBucketSchema>;
export const SalesReportResponseSchema = z.object({
  period: ReportPeriodSchema,
  view: SalesViewSchema,
  bucket: SalesBucketSchema.nullable(),
  items: z.array(SalesReportItemSchema),
});
export type SalesReportItem = z.infer<typeof SalesReportItemSchema>;
export type SalesReportResponse = z.infer<typeof SalesReportResponseSchema>;

// ---- Products ----
export const ProductLevelSchema = z.enum(["product", "variant"]);
export const ProductViewSchema = z.enum(["sales", "no_sales_with_current_stock"]);
/**
 * One products row. For view=sales: currency + unitsSold/grossSalesMinor/allocatedDiscountsMinor/
 * netSalesMinor. For view=no_sales_with_current_stock: onHandQuantity (the precise V1 non-moving signal;
 * there is no "slow moving score" and no low-stock label without a persisted reorder threshold).
 * variantId/sku present at level=variant; productId/productName always present.
 */
export const ProductReportItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  variantId: z.string().uuid().optional(),
  sku: z.string().optional(),
  currency: CurrencySchema.optional(),
  unitsSold: QuantitySchema.optional(),
  grossSalesMinor: MinorSchema.optional(),
  allocatedDiscountsMinor: MinorSchema.optional(),
  netSalesMinor: MinorSchema.optional(),
  onHandQuantity: QuantitySchema.optional(),
});
export type ProductLevel = z.infer<typeof ProductLevelSchema>;
export type ProductView = z.infer<typeof ProductViewSchema>;
export const ProductsReportResponseSchema = z.object({
  period: ReportPeriodSchema,
  level: ProductLevelSchema,
  view: ProductViewSchema,
  items: z.array(ProductReportItemSchema),
  pageInfo: PageInfoSchema,
});
export type ProductReportItem = z.infer<typeof ProductReportItemSchema>;
export type ProductsReportResponse = z.infer<typeof ProductsReportResponseSchema>;

// ---- Inventory ----
export const InventoryViewSchema = z.enum([
  "balances",
  "movements",
  "receipts",
  "transfers",
  "adjustments",
]);
/**
 * One inventory row. balances (current state, not as-of): variantId/sku/productId/productName/
 * inventoryLocationId/locationName/branchId/onHandQuantity/version. movements: operationId/operationType/
 * occurredAt/variantId/sku/inventoryLocationId/locationName/quantityDelta. receipts|transfers|
 * adjustments: operationId/operationType/occurredAt/actorMembershipId/notes/supplierId/supplierName/
 * lineCount/unitsIn/unitsOut.
 */
export const InventoryReportItemSchema = z.object({
  variantId: z.string().uuid().optional(),
  sku: z.string().optional(),
  productId: z.string().uuid().optional(),
  productName: z.string().optional(),
  inventoryLocationId: z.string().uuid().optional(),
  locationName: z.string().optional(),
  branchId: z.string().uuid().nullable().optional(),
  onHandQuantity: QuantitySchema.optional(),
  version: SafeIntegerSchema.optional(),
  operationId: z.string().uuid().optional(),
  operationType: z.string().optional(),
  occurredAt: IsoDateTimeSchema.optional(),
  actorMembershipId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  supplierName: z.string().nullable().optional(),
  lineCount: SafeIntegerSchema.optional(),
  unitsIn: QuantitySchema.optional(),
  unitsOut: QuantitySchema.optional(),
  quantityDelta: SafeIntegerSchema.optional(),
});
export type InventoryView = z.infer<typeof InventoryViewSchema>;
export const InventoryReportResponseSchema = z.object({
  period: ReportPeriodSchema.nullable(),
  view: InventoryViewSchema,
  items: z.array(InventoryReportItemSchema),
  asOf: IsoDateTimeSchema.nullable(),
  pageInfo: PageInfoSchema,
});
export type InventoryReportItem = z.infer<typeof InventoryReportItemSchema>;
export type InventoryReportResponse = z.infer<typeof InventoryReportResponseSchema>;

// ---- Returns ----
export const ReturnsViewSchema = z.enum(["summary", "products", "variants"]);
export const ReturnsSummaryByCurrencySchema = z.object({
  currency: CurrencySchema,
  acceptedReturnedValueMinor: MinorSchema,
  returnCount: SafeIntegerSchema,
  succeededRefundMinor: MinorSchema,
  pendingRefundMinor: MinorSchema,
});
export const ReturnsReportItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  variantId: z.string().uuid().optional(),
  sku: z.string().optional(),
  currency: CurrencySchema,
  returnedQuantity: QuantitySchema,
  returnedValueMinor: MinorSchema,
});
export type ReturnsView = z.infer<typeof ReturnsViewSchema>;
export const ReturnsReportResponseSchema = z.object({
  period: ReportPeriodSchema,
  view: ReturnsViewSchema,
  summary: z
    .object({
      byCurrency: z.array(ReturnsSummaryByCurrencySchema),
      byDisposition: z.array(
        z.object({ disposition: z.string(), returnedQuantity: QuantitySchema }),
      ),
    })
    .optional(),
  items: z.array(ReturnsReportItemSchema).optional(),
  pageInfo: PageInfoSchema.optional(),
});
export type ReturnsReportItem = z.infer<typeof ReturnsReportItemSchema>;
export type ReturnsReportResponse = z.infer<typeof ReturnsReportResponseSchema>;

// ---- Promotions ----
export const PromotionsReportItemSchema = z.object({
  promotionId: z.string().uuid(),
  promotionName: z.string().nullable(),
  codeSnapshot: z.string().nullable(),
  currency: CurrencySchema,
  redemptionCount: SafeIntegerSchema,
  discountAmountMinor: MinorSchema,
  orderCount: SafeIntegerSchema,
  grossSalesMinor: MinorSchema,
  netSalesMinor: MinorSchema,
  cancelledOrderCount: SafeIntegerSchema,
});
export const PromotionsReportResponseSchema = z.object({
  period: ReportPeriodSchema,
  items: z.array(PromotionsReportItemSchema),
});
export type PromotionsReportItem = z.infer<typeof PromotionsReportItemSchema>;
export type PromotionsReportResponse = z.infer<typeof PromotionsReportResponseSchema>;

// ---- Suppliers ----
export const SuppliersReportItemSchema = z.object({
  supplierId: z.string().uuid(),
  supplierName: z.string().nullable(),
  supplierNameSnapshot: z.string().nullable(),
  receiptCount: SafeIntegerSchema,
  unitsReceived: QuantitySchema,
  lastReceiptAt: IsoDateTimeSchema.nullable(),
});
export const SuppliersReportResponseSchema = z.object({
  period: ReportPeriodSchema,
  items: z.array(SuppliersReportItemSchema),
  pageInfo: PageInfoSchema,
});
export type SuppliersReportItem = z.infer<typeof SuppliersReportItemSchema>;
export type SuppliersReportResponse = z.infer<typeof SuppliersReportResponseSchema>;
