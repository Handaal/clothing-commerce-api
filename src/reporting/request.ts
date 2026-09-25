import { z } from "zod";
import {
  InventoryViewSchema,
  ProductLevelSchema,
  ProductViewSchema,
  ReturnsViewSchema,
  SalesBucketSchema,
  SalesViewSchema,
} from "../contracts/management/reporting";
import { ReportExportDatasetSchema } from "../contracts/management/reporting-export";

/**
 * Reporting query schemas. Dates are inclusive tenant-local calendar dates (YYYY-MM-DD); the server
 * resolves them to a half-open UTC range via tenants.default_timezone. `limit`/`cursor` drive opaque
 * forward pagination on list-style reports; the cursor carries only an offset and never authorization.
 */

const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected an ISO calendar date (YYYY-MM-DD).")
  .refine((value) => {
    // Reject impossible calendar dates (e.g. 2026-13-01): Date normalizes them, so a round-trip differs.
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a valid calendar date.");

const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);
const CursorSchema = z.string().min(1).max(200).optional();

const dateRange = { startDate: CalendarDateSchema, endDate: CalendarDateSchema };

export const SummaryQuerySchema = z.object({ ...dateRange }).strict();
export const SalesQuerySchema = z
  .object({
    ...dateRange,
    view: SalesViewSchema.default("trend"),
    bucket: SalesBucketSchema.default("day"),
  })
  .strict();
export const ProductsQuerySchema = z
  .object({
    ...dateRange,
    level: ProductLevelSchema.default("variant"),
    view: ProductViewSchema.default("sales"),
    limit: LimitSchema,
    cursor: CursorSchema,
  })
  .strict();
export const InventoryQuerySchema = z
  .object({
    view: InventoryViewSchema.default("balances"),
    // Required for every view except `balances` (current state); enforced in the service.
    startDate: CalendarDateSchema.optional(),
    endDate: CalendarDateSchema.optional(),
    limit: LimitSchema,
    cursor: CursorSchema,
  })
  .strict();
export const ReturnsQuerySchema = z
  .object({
    ...dateRange,
    view: ReturnsViewSchema.default("summary"),
    limit: LimitSchema,
    cursor: CursorSchema,
  })
  .strict();
export const PromotionsQuerySchema = z.object({ ...dateRange }).strict();
export const SuppliersQuerySchema = z
  .object({ ...dateRange, limit: LimitSchema, cursor: CursorSchema })
  .strict();

/**
 * CSV export query. The bounded `dataset` selector chooses the canonical dataset; `startDate`/`endDate`
 * carry the SAME inclusive tenant-local calendar-date semantics as the JSON reports. `level` is only
 * meaningful for the sales-products dataset (product vs variant grain) and is ignored by the others.
 */
export const ExportQuerySchema = z
  .object({
    dataset: ReportExportDatasetSchema,
    ...dateRange,
    level: ProductLevelSchema.default("variant"),
  })
  .strict();

export type SummaryQuery = z.infer<typeof SummaryQuerySchema>;
export type SalesQuery = z.infer<typeof SalesQuerySchema>;
export type ProductsQuery = z.infer<typeof ProductsQuerySchema>;
export type InventoryQuery = z.infer<typeof InventoryQuerySchema>;
export type ReturnsQuery = z.infer<typeof ReturnsQuerySchema>;
export type PromotionsQuery = z.infer<typeof PromotionsQuerySchema>;
export type SuppliersQuery = z.infer<typeof SuppliersQuerySchema>;
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
