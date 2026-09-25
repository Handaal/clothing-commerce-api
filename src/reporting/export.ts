import type { z } from "zod";
import {
  InventoryMovementsExportResponseSchema,
  ReportExportDatasetSchema,
  ReturnsExportResponseSchema,
  SalesProductsExportResponseSchema,
  SupplierReceiptsExportResponseSchema,
  type InventoryMovementsExportRow,
  type ReportExportDataset,
  type ReturnsExportRow,
  type SalesProductsExportRow,
  type SupplierReceiptsExportRow,
} from "../contracts/management/reporting-export";
import { toCsv, type CsvCell } from "./csv";

/**
 * The bounded export dataset registry: for each canonical selector, the sanctioned reporting_private RPC,
 * the row-payload schema the repository validates, and the fixed, ordered CSV column projection. Column
 * order and header names are frozen so the CSV output is deterministic. String columns are neutralized
 * against formula injection by the CSV writer; numeric columns are emitted verbatim (see ./csv.ts).
 */

interface Column<Row> {
  readonly header: string;
  readonly cell: (row: Row) => CsvCell;
}

const str = <Row>(header: string, get: (row: Row) => string | null): Column<Row> => ({
  header,
  cell: (row) => ({ kind: "string", value: get(row) ?? "" }),
});

const num = <Row>(header: string, get: (row: Row) => number | null): Column<Row> => ({
  header,
  cell: (row) => {
    const value = get(row);
    // A null numeric renders as an empty cell (never 0, never neutralized).
    return value === null ? { kind: "string", value: "" } : { kind: "number", value };
  },
});

const salesProductsColumns: ReadonlyArray<Column<SalesProductsExportRow>> = [
  str("productId", (r) => r.productId),
  str("productName", (r) => r.productName),
  str("variantId", (r) => r.variantId),
  str("sku", (r) => r.sku),
  str("level", (r) => r.level),
  str("currency", (r) => r.currency),
  num("unitsSold", (r) => r.unitsSold),
  num("grossSalesMinor", (r) => r.grossSalesMinor),
  num("allocatedDiscountsMinor", (r) => r.allocatedDiscountsMinor),
  num("netSalesMinor", (r) => r.netSalesMinor),
];

const inventoryMovementsColumns: ReadonlyArray<Column<InventoryMovementsExportRow>> = [
  str("occurredAt", (r) => r.occurredAt),
  str("operationType", (r) => r.operationType),
  str("operationId", (r) => r.operationId),
  str("productId", (r) => r.productId),
  str("productName", (r) => r.productName),
  str("variantId", (r) => r.variantId),
  str("sku", (r) => r.sku),
  str("inventoryLocationId", (r) => r.inventoryLocationId),
  str("locationName", (r) => r.locationName),
  num("quantityDelta", (r) => r.quantityDelta),
  str("notes", (r) => r.notes),
  str("supplierId", (r) => r.supplierId),
  str("supplierName", (r) => r.supplierName),
];

const returnsColumns: ReadonlyArray<Column<ReturnsExportRow>> = [
  str("returnId", (r) => r.returnId),
  str("orderId", (r) => r.orderId),
  str("returnCreatedAt", (r) => r.returnCreatedAt),
  str("productId", (r) => r.productId),
  str("productName", (r) => r.productName),
  str("variantId", (r) => r.variantId),
  str("sku", (r) => r.sku),
  str("currency", (r) => r.currency),
  num("returnedQuantity", (r) => r.returnedQuantity),
  num("acceptedNetReturnAmountMinor", (r) => r.acceptedNetReturnAmountMinor),
  str("disposition", (r) => r.disposition),
  str("refundId", (r) => r.refundId),
  str("refundStatus", (r) => r.refundStatus),
  num("refundAmountMinor", (r) => r.refundAmountMinor),
  str("refundSettledAt", (r) => r.refundSettledAt),
];

const supplierReceiptsColumns: ReadonlyArray<Column<SupplierReceiptsExportRow>> = [
  str("operationId", (r) => r.operationId),
  str("occurredAt", (r) => r.occurredAt),
  str("supplierId", (r) => r.supplierId),
  str("supplierName", (r) => r.supplierName),
  str("supplierNameSnapshot", (r) => r.supplierNameSnapshot),
  str("productId", (r) => r.productId),
  str("productName", (r) => r.productName),
  str("variantId", (r) => r.variantId),
  str("sku", (r) => r.sku),
  num("unitsReceived", (r) => r.unitsReceived),
  str("inventoryLocationId", (r) => r.inventoryLocationId),
  str("locationName", (r) => r.locationName),
];

/**
 * A row-type-erased dataset config: the RPC contract, whether it takes the sales-products `p_level`
 * argument, a validating `parse`, and the frozen CSV projection (`headers` + `toCells`). Erasing the row
 * type here lets a single record hold all four heterogeneous datasets.
 */
interface ExportDatasetConfig {
  readonly rpc: string;
  readonly usesLevel: boolean;
  readonly parse: (data: unknown) => { period: unknown; rows: unknown[] };
  readonly headers: readonly string[];
  readonly toCells: (row: unknown) => CsvCell[];
}

function defineDataset<Row>(config: {
  rpc: string;
  usesLevel: boolean;
  responseSchema: z.ZodType<{ period: unknown; rows: Row[] }>;
  columns: ReadonlyArray<Column<Row>>;
}): ExportDatasetConfig {
  return {
    rpc: config.rpc,
    usesLevel: config.usesLevel,
    parse: (data) => config.responseSchema.parse(data),
    headers: config.columns.map((column) => column.header),
    toCells: (row) => config.columns.map((column) => column.cell(row as Row)),
  };
}

export const EXPORT_DATASETS: Record<ReportExportDataset, ExportDatasetConfig> = {
  "sales-products": defineDataset({
    rpc: "export_sales_products",
    usesLevel: true,
    responseSchema: SalesProductsExportResponseSchema,
    columns: salesProductsColumns,
  }),
  "inventory-movements": defineDataset({
    rpc: "export_inventory_movements",
    usesLevel: false,
    responseSchema: InventoryMovementsExportResponseSchema,
    columns: inventoryMovementsColumns,
  }),
  returns: defineDataset({
    rpc: "export_returns",
    usesLevel: false,
    responseSchema: ReturnsExportResponseSchema,
    columns: returnsColumns,
  }),
  "supplier-receipts": defineDataset({
    rpc: "export_supplier_receipts",
    usesLevel: false,
    responseSchema: SupplierReceiptsExportResponseSchema,
    columns: supplierReceiptsColumns,
  }),
};

/** The frozen media type for every export document. */
export const EXPORT_MEDIA_TYPE = "text/csv";

/** Deterministic download filename, e.g. `sales-products_2026-06-01_2026-06-30.csv`. */
export function exportFilename(
  dataset: ReportExportDataset,
  startDate: string,
  endDate: string,
): string {
  return `${dataset}_${startDate}_${endDate}.csv`;
}

/** Renders the validated dataset rows to the deterministic CSV body for the given dataset. */
export function renderExportCsv(dataset: ReportExportDataset, rows: readonly unknown[]): string {
  const config = EXPORT_DATASETS[dataset];
  return toCsv(
    config.headers,
    rows.map((row) => config.toCells(row)),
  );
}

export { ReportExportDatasetSchema };
