-- Phase 2D (2/5): idempotent platform Permission catalog seed.
--
-- public.permissions is a platform-global, immutable, non-secret capability contract keyed by the
-- stable text `key`. Prior phases deliberately deferred seeding, leaving inventory keys living only in
-- application code/tests. Phase 2D closes that contract gap: the keys the application authorizes
-- against are now persisted so future role governance can grant them.
--
-- This migration SEEDS THE CATALOG ONLY. It never assigns a permission to a Role and never creates a
-- role_permissions row: catalog provisioning is not the same act as granting. The insert is idempotent
-- (`on conflict (key) do nothing`), so re-applying the migration or applying it after a key already
-- exists is a no-op. Descriptions are stable capability metadata, not credentials.

insert into public.permissions (key, description)
values
  ('inventory.read', 'Read inventory balances for an inventory location.'),
  ('inventory.adjust', 'Set opening stock or reconcile an inventory count.'),
  ('inventory.receive', 'Record received stock into an inventory location.'),
  ('inventory.issue', 'Issue stock out of an inventory location.'),
  ('inventory.transfer', 'Transfer stock between two inventory locations.'),
  ('orders.read', 'Read orders in the authorized brand or branch scope.'),
  ('orders.create', 'Create orders in the authorized brand or branch scope.'),
  ('orders.cancel', 'Cancel orders in the authorized brand or branch scope.')
on conflict (key) do nothing;
