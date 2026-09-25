# Reporting Core (Phase 2Q-A)

Operational, read-only reporting for owners/managers. **Not** accounting, BI, OLAP, forecasting, or
profitability. The frozen financial/time/currency definitions live in
[ADR-038](../decisions/ADR-038-operational-reporting-definitions.md); this document is the surface
reference.

## Architecture

```
GET /api/v1/reports/*  →  ReportingService (authorize reports.read, validate query)
                       →  ReportingRepository (tenant from proof; opaque cursor <-> offset)
                       →  reporting_private.* SECURITY DEFINER read RPCs
                       →  canonical tables (orders, order_lines, adjustments, redemptions,
                          returns, refunds, inventory_*, suppliers, org/catalog)
```

- Role `reporting_reader` (NOLOGIN, NOBYPASSRLS) owns the `reporting_private` functions and holds the
  minimum SELECT grants + permissive read policies on exactly the tables reports project. `service_role`
  may only EXECUTE the RPCs.
- Each RPC is SECURITY DEFINER with `search_path=''`, fully-qualified names, tenant derived from the
  caller-supplied verified id, and performs no writes.
- Migration: `supabase/migrations/20260925180000_create_reporting.sql`. Permission seed: `reports.read`.

## Time & currency (frozen)

- `startDate`/`endDate` are inclusive tenant-local calendar dates; the server resolves them via
  `tenants.default_timezone` to `[fromInclusive, toExclusive)` (UTC) and returns
  `period { timezone, fromInclusive, toExclusive }`. Weeks start Monday. DST-correct.
- Every monetary result is grouped by currency and **never** summed across currencies.
- Event timestamps: sales `orders.placed_at`; inventory `occurred_at`; returns `returns.created_at`;
  refunds `refunds.settled_at`; promotions `promotion_redemptions.redeemed_at`.

## Endpoints

All require a tenant-wide `reports.read` grant and the `X-Tenant-Id` header. `limit` 1–200 (default 50);
`cursor` is an opaque forward cursor (never construct it client-side — use the SDK).

| Endpoint                  | Query                                       | Returns                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /reports/summary`    | `startDate,endDate`                         | `period`, `salesByCurrency[]` (gross/discounts/net/orderCount/AOV), `returns { byCurrency[], refundsByCurrency[] }` (succeeded refunds are period-bound; pending is the current obligation), `stock`, `inventoryAsOf` |
| `GET /reports/sales`      | `startDate,endDate,view,bucket`             | currency-grouped rows for `view` ∈ trend/channel/brand/pos_branch/pos_register/pos_operator. `bucket` ∈ day/week/month for trend. POS views are POS-only                                                              |
| `GET /reports/products`   | `startDate,endDate,level,view,limit,cursor` | `level` ∈ product/variant. `view=sales`: units/gross/allocatedDiscounts/net by currency. `view=no_sales_with_current_stock`: current on-hand with no placed sale in period                                            |
| `GET /reports/inventory`  | `view,[startDate,endDate],limit,cursor`     | `balances` (current state, no period, `asOf`), or event-period `movements`/`receipts`/`transfers`/`adjustments`. `startDate`/`endDate` required for every view except `balances`                                      |
| `GET /reports/returns`    | `startDate,endDate,view,limit,cursor`       | `view=summary`: `byCurrency[]` (accepted returned value + succeeded/pending refunds) + `byDisposition[]`. `products`/`variants`: net returned value/quantity by currency. No return-rate KPI                          |
| `GET /reports/promotions` | `startDate,endDate`                         | per-promotion, per-currency redemptionCount / discountAmount / order/gross/net / cancelledOrderCount, from immutable redemption + adjustment snapshots. No ROI                                                        |
| `GET /reports/suppliers`  | `startDate,endDate,limit,cursor`            | per-supplier receiptCount / unitsReceived / lastReceiptAt + current name and immutable snapshot label. No spend/value                                                                                                 |

## Attribution rules

Brand: all Orders. Branch/Register/Operator: POS only (ONLINE Orders carry none; never inferred from
fulfillment/inventory location). Supplier: attributed post-2N receipts only. Promotion: Phase 2P
discounted Orders. Missing legacy attribution is handled safely, never fabricated.

## SDK

`@shifted/clothing-commerce-sdk@0.13.0` exposes `getReportSummary`, `getSalesReport`,
`getProductsReport`, `getInventoryReport`, `getReturnsReport`, `getPromotionsReport`,
`getSuppliersReport` on the tenant client, with typed filters, DTOs, period metadata, and cursor types.
`getContext().access.reports?.canRead` is UI guidance only.

## Tests

- Persistence: `pnpm test:reporting:persistence`
  (`supabase/tests/phase_2q_reporting_persistence.sql`, twice from an empty schema) — currency
  isolation, tenant isolation, tenant-local + DST boundaries, POS/online split, brand/branch/
  register/operator attribution, cancellation semantics, discounted net returns basis, pending vs
  succeeded refunds, immutable promotion snapshots, supplier receipts without cost, the non-moving
  signal, cursor bounds, empty periods.
- Authorization/validation: `tests/reporting/service.test.ts` (reports.read required; scoped grant is
  not tenant-wide; query validation).
- OpenAPI drift/structure and the SDK consumer gate cover the surface.
