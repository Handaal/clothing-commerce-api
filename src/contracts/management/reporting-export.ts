import { z } from "zod";
import { CurrencySchema, IsoDateTimeSchema, SafeIntegerSchema } from "../common/serialization";
import { ProductLevelSchema, ReportPeriodSchema } from "./reporting";

/**
 * Phase 2Q-C CSV export DTOs. Bounded V1 datasets ONLY — there is no dashboard/promotion/PDF/XLSX export,
 * no scheduled/email delivery, and no generic report or arbitrary-SQL export builder. Every export reuses
 * the frozen reporting semantics (see docs/reporting/reporting-core.md and ADR-038):
 *
 *  - Authorization is the SAME tenant-wide reports.read as the JSON reports; there is no export permission.
 *  - Inputs are inclusive tenant-local calendar dates resolved via tenants.default_timezone to a half-open
 *    UTC range; every export echoes that resolved `period`.
 *  - Every monetary row carries its own `currency`; currencies are NEVER summed or combined.
 *  - Exports are bounded: at most EXPORT_MAX_RANGE_DAYS calendar days and EXPORT_MAX_ROWS rows. Exceeding
 *    either is an explicit error — the server NEVER silently truncates.
 *
 * These row schemas validate the sanctioned reporting_private export RPC payloads at the repository
 * boundary. The public HTTP surface is a CSV document; the SDK returns the CSV body plus its media type
 * and filename so Admin never constructs URLs or parses the payload itself.
 */

/** Maximum inclusive calendar-day span (about one year, leap-safe) any single export may cover. */
export const EXPORT_MAX_RANGE_DAYS = 366;
/** Maximum row count any single export may materialize. Exceeding it is an explicit error, never a cut. */
export const EXPORT_MAX_ROWS = 50_000;

/** The bounded, canonical export dataset selector. Arbitrary report/table names are not accepted. */
export const ReportExportDatasetSchema = z.enum([
  "sales-products",
  "inventory-movements",
  "returns",
  "supplier-receipts",
]);
export type ReportExportDataset = z.infer<typeof ReportExportDatasetSchema>;

const MinorSchema = SafeIntegerSchema;
const QuantitySchema = SafeIntegerSchema;

// ---- sales-products ----
export const SalesProductsExportRowSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  variantId: z.string().uuid().nullable(),
  sku: z.string().nullable(),
  level: ProductLevelSchema,
  currency: CurrencySchema,
  unitsSold: QuantitySchema,
  grossSalesMinor: MinorSchema,
  allocatedDiscountsMinor: MinorSchema,
  netSalesMinor: MinorSchema,
});
export type SalesProductsExportRow = z.infer<typeof SalesProductsExportRowSchema>;

// ---- inventory-movements ----
export const InventoryMovementsExportRowSchema = z.object({
  occurredAt: IsoDateTimeSchema,
  operationType: z.string(),
  operationId: z.string().uuid(),
  productId: z.string().uuid(),
  productName: z.string(),
  variantId: z.string().uuid(),
  sku: z.string(),
  inventoryLocationId: z.string().uuid(),
  locationName: z.string(),
  quantityDelta: SafeIntegerSchema,
  notes: z.string().nullable(),
  supplierId: z.string().uuid().nullable(),
  supplierName: z.string().nullable(),
});
export type InventoryMovementsExportRow = z.infer<typeof InventoryMovementsExportRowSchema>;

// ---- returns ----
export const ReturnsExportRowSchema = z.object({
  returnId: z.string().uuid(),
  orderId: z.string().uuid(),
  returnCreatedAt: IsoDateTimeSchema,
  productId: z.string().uuid(),
  productName: z.string(),
  variantId: z.string().uuid(),
  sku: z.string().nullable(),
  currency: CurrencySchema,
  returnedQuantity: QuantitySchema,
  acceptedNetReturnAmountMinor: MinorSchema,
  disposition: z.string(),
  refundId: z.string().uuid().nullable(),
  refundStatus: z.string().nullable(),
  refundAmountMinor: MinorSchema.nullable(),
  refundSettledAt: IsoDateTimeSchema.nullable(),
});
export type ReturnsExportRow = z.infer<typeof ReturnsExportRowSchema>;

// ---- supplier-receipts ----
export const SupplierReceiptsExportRowSchema = z.object({
  operationId: z.string().uuid(),
  occurredAt: IsoDateTimeSchema,
  supplierId: z.string().uuid(),
  supplierName: z.string().nullable(),
  supplierNameSnapshot: z.string().nullable(),
  productId: z.string().uuid(),
  productName: z.string(),
  variantId: z.string().uuid(),
  sku: z.string(),
  unitsReceived: QuantitySchema,
  inventoryLocationId: z.string().uuid(),
  locationName: z.string(),
});
export type SupplierReceiptsExportRow = z.infer<typeof SupplierReceiptsExportRowSchema>;

/** A sanctioned export RPC payload: the resolved period plus the dataset rows. */
export function exportRowsResponseSchema<T extends z.ZodTypeAny>(row: T) {
  return z.object({ period: ReportPeriodSchema, rows: z.array(row) });
}

export const SalesProductsExportResponseSchema = exportRowsResponseSchema(
  SalesProductsExportRowSchema,
);
export const InventoryMovementsExportResponseSchema = exportRowsResponseSchema(
  InventoryMovementsExportRowSchema,
);
export const ReturnsExportResponseSchema = exportRowsResponseSchema(ReturnsExportRowSchema);
export const SupplierReceiptsExportResponseSchema = exportRowsResponseSchema(
  SupplierReceiptsExportRowSchema,
);
