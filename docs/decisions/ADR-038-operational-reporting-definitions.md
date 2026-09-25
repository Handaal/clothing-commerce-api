# ADR-038: Operational Reporting Definitions (Phase 2Q-A)

- Status: Accepted
- Date: 2026-09-25

## Context

Phase 2Q introduces the first reporting surface. The platform already holds every fact reporting needs
(canonical Orders with the Phase 2P accounting evolution, immutable adjustments/redemptions, returns,
refunds, the inventory ledger, suppliers). What was undecided (see the "Reporting / export
expectations" deferral in `docs/platform/current-v1-state.md`) was the exact financial, time, and
currency semantics a report must obey. Getting these wrong silently corrupts owner decisions, so they
are frozen here rather than left to each endpoint.

This is **operational** reporting — read-only summaries an owner uses to run the business day to day. It
is explicitly **not** accounting, BI, OLAP, forecasting, or profitability. There is no cost basis in V1
(ADR on suppliers deferred unit cost), so margin/ROI/profit are impossible and out of scope.

## Decision

Frozen V1 reporting definitions:

1. **Tenant-wide only.** Every report requires a tenant-wide `reports.read` grant. There is no scoped
   reporting; a brand/branch-scoped grant never confers reporting. All endpoints reauthorize
   server-side (a UI `access.reports.canRead` hint never grants access).
2. **Read-only.** Reporting performs no writes. A dedicated non-login `reporting_reader` role owns the
   `reporting_private` SECURITY DEFINER read functions with an empty `search_path`, fully-qualified
   tables, and the minimum SELECT grants; `service_role` may only EXECUTE the sanctioned RPCs.
3. **Currency is never combined.** Every monetary result is grouped by currency. No report sums across
   currencies, ever.
4. **Time.** Inputs are inclusive tenant-local calendar dates `startDate`/`endDate`. The server resolves
   them, via `tenants.default_timezone`, to a half-open UTC instant range `[fromInclusive, toExclusive)`
   and echoes `{ timezone, fromInclusive, toExclusive }`. Trend weeks start Monday. DST is handled by
   Postgres `at time zone`. Event timestamps: sales `orders.placed_at`, inventory `occurred_at`, returns
   `returns.created_at`, refunds `refunds.settled_at`, promotions `promotion_redemptions.redeemed_at`.
   Offline POS placement uses `placed_at` (the accepted-at instant), not server ingestion time.
5. **Sales financials** are computed over Orders currently `status='placed'`:
   - Gross sales = `Σ gross_subtotal_minor`; Discounts = `Σ discount_total_minor`;
     Net sales = `Σ total_minor`; Order count = `COUNT(*)`;
     AOV = `round(net / count)` in minor units, **null** when count = 0.
   - Operational Orders are never called revenue, recognized revenue, or cash collected.
   - A later cancellation/return does **not** rewrite historical sales; net-after-returns is not a
     primary KPI. Returns/refunds are separate event-period metrics, and pending refunds are reported as
     the current obligation (not period-bound).
6. **Attribution** is only ever what the data supports: brand for all Orders; branch/register/operator
   for POS only (ONLINE Orders carry none — "sales by branch" means POS sales by branch, never inferred
   from fulfillment or inventory location); supplier only for attributed post-2N receipts; promotion
   only for Phase 2P discounted Orders. Missing legacy attribution is handled safely, never fabricated.
7. **Products** expose `no_sales_with_current_stock` as the precise non-moving signal (positive current
   on-hand and no placed sale line in the period). There is no "slow moving score" and no low-stock
   label (no persisted reorder threshold exists).
8. **Promotions** are reported from the immutable `promotion_redemptions` + `order_adjustments`
   snapshots (name/code survive a later live rename), never reconstructed from live config. No ROI.
9. **Suppliers** report receipt count, units received, and last receipt only. No spend/value — there is
   no acquisition cost basis.
10. **No materialized views / summary tables / fact tables / warehouse / generic query builder** in V1.
    Reports read canonical tables directly; indexes are added only when EXPLAIN proves need.

## Consequences

- Reports are always explainable from canonical rows and immutable snapshots.
- The surface is compact: `summary`, `sales`, `products`, `inventory`, `returns`, `promotions`,
  `suppliers` (see `docs/reporting/reporting-core.md`), delivered in SDK `0.13.0`.
- Profitability, scheduled reports, scoped/branch-local reporting, and any as-of historical inventory
  remain deferred.

## Addendum (Phase 2Q-C): bounded CSV export

A read-only CSV export was added for four bounded datasets (`sales-products`, `inventory-movements`,
`returns`, `supplier-receipts`) at `GET /api/v1/reports/export`, delivered in SDK `0.13.1`. It reuses
every definition above unchanged — the same `reports.read` tenant-wide authorization (no separate export
permission), the same tenant-timezone date resolution and echoed `period`, the same per-currency /
never-combined rule, the same net-discounted return basis (gross never reconstructed), and the same "no
supplier cost/spend/value" rule. Additional export-only decisions: exports are **bounded** (≤ 366 days →
`422`; ≤ 50 000 rows → `413`) and **never silently truncate**; CSV is UTF-8 / RFC 4180 / deterministic
with spreadsheet formula-injection neutralization on string cells beginning with `= + - @`, TAB, or CR.
PDF/XLSX, a generic/scheduled/emailed export, and arbitrary-SQL export remain out of scope. See
`docs/reporting/reporting-core.md`.
