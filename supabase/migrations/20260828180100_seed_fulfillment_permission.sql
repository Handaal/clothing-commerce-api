-- Phase 2E (2/7): provision the single new platform Permission key for Fulfillment.
--
-- public.permissions is a platform-global, immutable, non-secret capability contract keyed by the
-- stable text `key`. A NEW Fulfillment requires TWO authorities: the commercial authority to fulfill an
-- Order (orders.fulfill, seeded here) AND the existing custody authority to issue stock out of an
-- inventory location (inventory.issue, seeded in Phase 2D). Reads reuse orders.read. No fulfillment.*
-- key exists: fulfillment is a composite of a commercial and a custody capability, never a single new
-- permission.
--
-- This migration SEEDS THE CATALOG ONLY. It never assigns the permission to a Role and never creates a
-- role_permissions row: catalog provisioning is not the same act as granting. The insert is idempotent
-- (`on conflict (key) do nothing`), so re-applying it, or applying it after the key already exists, is a
-- no-op.

insert into public.permissions (key, description)
values
  ('orders.fulfill', 'Fulfill orders in the authorized brand or branch scope (commercial authority).')
on conflict (key) do nothing;
