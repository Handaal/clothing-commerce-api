# Register workforce and stock changes (local 0.30.0 branch)

The POS availability route, `GET /api/v1/pos/availability?registerId=...`, checks that the caller
can sell from the active register and returns on-hand balances for its default inventory location.
The register uses this for stock totals and disables known out-of-stock variants. The sale transaction
still enforces the authoritative stock check. Availability is a snapshot, not a reservation.

New variants receive a tenant-wide numeric Code 128 barcode from 1000 onward. The migration backfills
variants that lack a barcode and exposes primary barcodes in product detail and inventory list data.
Existing barcodes stay in place. The POS prints labels; print layout and physical printer selection
remain local to the desktop app.

Staff without system access are created through `POST /api/v1/staff/without-login` as active
memberships without a provider binding or role assignment. POS login accounts remain separately
managed and receive explicit role/scope and page grants. Payroll cycle settings and payment records
are tenant-scoped and stored in PostgreSQL; the API computes the last completed cycle from the
configured day (1–28), derives the amount from its payroll report, and records one payment per period.

Staff profiles keep an optional position, phone, and editable tenant display name on the membership.
`PUT /api/v1/staff/{membershipId}/profile` requires tenant-wide `staff.manage` and an idempotency key.
Editing a linked account does not rename its global login identity. Staff list/detail responses include
these fields for the POS team roster and payroll labels.

Offline team clock commands keep the signing operator and include an optional target membership.
Older commands without a target still clock their operator. On ingestion, the API checks the device
signature and grant, matches the operator to the grant, requires a tenant-wide
`attendance.manage` grant when the target differs from the operator, confirms the target is active,
and applies a
valid clock event to canonical attendance in the same transaction as the replay-safe ingestion row.
Duplicate delivery returns the original result. An invalid clock sequence returns a blocking error
for the POS review lane; it does not create partial attendance. Clock times use the bounded device
event time, so payroll reports include the shift after sync.

A POS sale may update an existing customer's name when the cashier supplies the same phone number.
The phone remains the matching key. The customer change and sale commit in one transaction.
