# ADR-041 (PROPOSED — NOT APPROVED): Offline cashier expansion decisions

- Status: **PARTIALLY APPROVED (scope-level) 2026-11-11.** Drafted 2026-11-08 during offline-first
  Phase 6B review. No behaviour, contract, migration, SDK, or policy has been changed by this document
  yet. See the Owner decision log directly below for what is now in scope.

## Owner decision log

- **2026-11-11 — target offline scope = "cashier shift + attendance + returns."** The owner chose this
  over "offline cashier shift only" and "whole POS offline." Consequences:
  - **Decision A (offline returns): APPROVED in direction — pursue Option 2** (server-issued signed
    offline-return grant; signed return command via the existing outbox; idempotent server accept +
    reconciliation; **refund settlement withheld to a cash-handback attestation against the canonical
    server amount**). Option 3 (client-computed refunds) remains rejected. _Remaining sub-decisions for
    the owner before merge:_ (A-i) max refundable amount / per-grant refund budget; (A-ii) grant validity
    window; (A-iii) whether exchange (return+new-sale) is in the first cut or refund-only.
  - **Decision C (offline attendance): APPROVED in direction — pursue Option 2** (append-only signed
    clock-in/out events in the outbox, idempotent replay, server-authoritative payroll derivation).
    _Remaining sub-decision:_ (C-i) attendance attribution rule — bind to the offline-PIN roster operator
    vs the grant operator (recommend: the authenticated offline-PIN operator).
  - **Decision B (non-cash tender semantics): CONFIRMED.** Keep Option 2 (preserve method; record as
    cashier-attested, **not** provider-settled). The D-2 mapping bug is already fixed. No UI may imply
    provider settlement until a gateway ADR exists.
  - **Decision D (offline promotions): remains OUT (Option 1 default).** Not approved; fail-closed stays.
  - **Not-in-scope items (inventory ops, orders/customers/reports/suppliers management, device
    governance, payroll, full reporting): remain ONLINE-ONLY by owner choice.** Read-cache is accepted
    as sufficient for a shift.
- Each approved item is still gated on: a feature flag, the detailed contract below, and **isolated
  real-API acceptance evidence** (no mocks on the core path) before it can be called done.

- (Original) Each sub-decision below needs an explicit owner sign-off before any implementation.
- Context owner inputs required: commercial/finance (refund + discount money, payment capture),
  operations (stock allocation tolerance, attendance attribution), security (grant bounds, device governance).
- Related: ADR-026 (immutable pricing snapshots), ADR-027 (order/payment/inventory separation),
  ADR-028 (order idempotency/replay), ADR-037 (promotion accounting), ADR-007/008 (device/identity),
  `clothing-commerce-pos/docs/offline-returns-promotions.md`, offline-first-roadmap §9–§10.

## Why this exists

The stated product goal is that the POS **cashier** workflow should proceed _mainly offline_ after a
one-time commissioning. Phase 6 proved the core sale path (cash sale, idempotent replay, reconciliation,
RLS, crash recovery) end-to-end against a real isolated API. The remaining cashier-facing gaps are
**returns**, **non-cash tender settlement**, **installments** (a defect, below), and **attendance**;
**promotions** remain architecturally out. This ADR frames each as an explicit decision. It deliberately
does **not** propose moving back-office/management mutations (inventory ledger, suppliers, settings,
device governance, payroll, server reporting) offline: those are global-authority or security-sensitive
and online-only is an acceptable, safer default for them.

> Not an ADR item — a bug to fix separately: the offline **installment-sale happy path** returns HTTP 500
> from `offline_pos_private.record_offline_sale` (installment branch) over the real server path
> (roadmap §10, case 3). That is a defect in already-shipped code, not a contract decision; fix under the
> normal bug process with a regression test. Do not conflate it with decision (B).

---

## Decision A (PROPOSED): Offline returns authority

**Problem.** Returns are server-authoritative (eligibility, net refund basis incl. promotions, settlement).
The offline cashier correctly disables returns today (fail-closed). This blocks a common cashier action
while disconnected.

**Options.**

1. Keep returns online-only (status quo). Zero new risk; cashier cannot refund offline.
2. **Server-issued, signed offline-return grant** (recommended if offline returns are required): mirror the
   offline-sale grant — a bounded, device/register-bound grant carrying per-line remaining-eligible
   quantities and a maximum refundable amount, valid for a short window; a signed offline-return command
   replayed through the existing outbox; idempotent server acceptance + reconciliation, with refund
   settlement kept `pending` until a cash-handback attestation against the canonical server amount.
3. Local return queue with client-computed refunds — **rejected** (contradicts Phase 2M; risks double/over
   refunds; client must never compute refund money).

**Recommendation.** Option 2, only if the business needs offline refunds. Reuse the offline-sale machinery;
never compute refund money on the client.

**Consequences / security / global consistency.** Eligibility is frozen at grant issuance, so concurrent
returns elsewhere can make an offline return over-refund → must be reconciled (and settlement withheld)
at ingestion, exactly like insufficient-stock today. Refund budget per grant bounds exposure.
**Test requirements.** Isolated real-API acceptance: grant issuance binding; signed return replay exactly
once; eligibility drift → reconciliation; settlement only after attestation; RLS. **Rollback.** Feature-flag
the grant issuance; with it off, returns fail-closed as today.

## Decision B (PROPOSED): Offline non-cash tender settlement semantics

**Problem.** Phase 6B found that a card-only offline tender submitted over the real HTTP path was persisted
as a **cash** capture (the `tenders` array did not take effect through offline ingestion; roadmap §10,
case 4). Separately, there is no integrated payment gateway: "captured" means cashier-attested, not
provider-settled (roadmap §4 owner decision, still open).

**Options.**

1. Status quo (non-cash recorded, effectively as cash) — misreports tender mix; reporting/reconciliation
   can't distinguish cash vs card offline.
2. **Preserve the tender method offline** (recommended): ensure the offline ingestion honours the signed
   `tenders[]` (method card/instapay/wallet) and records them as cashier-attested captures, exactly as the
   connected split-tender path does, with the UI never implying provider settlement.
3. Integrate a real gateway and make non-cash capture provisional until settlement — larger program; only
   if a provider is adopted.

**Recommendation.** Option 2 now (align offline with connected capture semantics; this is partly a bug fix
for case 4), and record a separate decision when/if a gateway is integrated. Until then "captured" must be
documented everywhere as attested, not settled.

**Consequences / security.** No new money authority; only correct attribution of tender method.
**Test requirements.** Isolated real-API acceptance asserting a card tender persists as `method=card`,
`cashReceivedMinor=null`, status captured; split cash+card sums to total. **Rollback.** None needed; it
restores intended behaviour.

## Decision C (PROPOSED): Offline attendance capture

**Problem.** Clock-in/out is online-only; the offline cashier cannot record a shift event while
disconnected. Attendance is a cashier/shift operation, not back-office.

**Options.**

1. Keep online-only (status quo) — staff cannot clock in/out offline.
2. **Queue append-only clock events offline** (recommended): sign clock-in/out events with the device key,
   persist in the outbox, replay idempotently; the server is authoritative for payroll derivation. Append-only
   events have no money and no global-allocation conflict, so this is low-risk.
3. Full offline payroll — **not recommended** (back-office; derived from attendance server-side).

**Recommendation.** Option 2 if offline shifts are required. **Consequences.** Attendance attribution must
bind to the authenticated operator (grant operator / offline PIN roster), and clock skew must be bounded
like sales (`CLOCK_ROLLBACK_TOLERANCE_MS`). **Owner choice:** attendance attribution rules.
**Test requirements.** Isolated acceptance: signed clock event replay exactly once; skew rejection; RLS.
**Rollback.** Feature-flag; off → online-only as today.

## Decision D (PROPOSED): Bounded pre-authorized promotion grant (only if offline discounts are ever wanted)

**Problem.** Offline promotions are currently both _not implemented_ and _prohibited by the approved
pricing architecture_ (ADR-026/037; the line-total identity + offline price authorization forbid a
client-applied discount). This is an engineering/V1 rule (`offline-returns-promotions.md`), **not** a
dedicated ADR saying "never". See roadmap §9.4.

**Options.**

1. **Keep offline promotions out (recommended default).** Safe; fail-closed; preserves canonical pricing.
2. Bounded, server-issued pre-authorized promotion grant: a short-lived signed discount budget with
   per-code redemption caps; the **server** performs final discount allocation + redemption recording at
   ingestion (never the client); offline the till may only apply discounts the grant pre-authorized, within
   budget, and anything exceeding it reconciles/repriced server-side.
3. Client-side promotion evaluation from a cached catalog — **rejected** (client computes forbidden money;
   no redemption/stacking/expiry enforcement; shared-redemption and discount-budget races).

**Recommendation.** Option 1 unless the business explicitly wants offline discounts; then Option 2 with a
dedicated approved ADR. **Risks to resolve first (Option 2):** expiry, per-code redemption limits, stacking,
eligibility drift, list-price changes, shared redemption across devices/channels, discount-budget
exhaustion, and replay/concurrency — none enforceable offline without the bounded grant + server-side
allocation. **Test requirements.** Isolated acceptance: budget cap, redemption idempotency, over-budget
reconciliation, no client-computed discount. **Rollback.** Grant issuance off → promotions fail-closed.

---

## What is explicitly NOT proposed for offline

Inventory receive/adjust/transfer/issue (global append-only ledger authority, ADR-017/023); suppliers /
purchases / dues / supplier payments (back-office money); operational settings & device governance
(security-sensitive; rotation/revocation need online authority); payroll (back-office, derived); full
server reporting (local pending-sync summary already covers the cashier's operational need). Online-only is
the recommended, safer default for these; revisit only with a specific owner-driven need and its own ADR.
