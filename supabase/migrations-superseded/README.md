# Withdrawn migrations (never applied to shared dev or production)

These files were written for parts of ADR-042 that the owner superseded on 2026-11-14 (night) — see
`docs/decisions/ADR-042-PROPOSED-channel-stock-pools-and-offline-pos-scope.md` §13. They were pending
(not in `supabase_migrations.schema_migrations` of shared dev when inspected read-only) and uncommitted,
so they were moved here instead of being edited. Supabase does not read this folder.

| File                                                      | Why withdrawn                                                                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261115130000_offline_tender_awaiting_confirmation.sql` | Stored offline card/InstaPay/wallet tenders as `pending` "awaiting provider confirmation". The POS has no payment gateway; tenders are cashier-recorded (§13.3). |
| `20261115140000_channel_allocation_versions.sql`          | Versioned Website/POS stock split. Stock splitting is not part of the product (§13.1).                                                                           |

Do not move a file back into `supabase/migrations/` without a new owner decision. If any environment is
ever found to have applied one of them, leave its history alone and supersede it with a new forward
migration.
