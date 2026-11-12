-- Phase 2F-A (1/2): provision the single new platform Permission key for management catalog reads.
--
-- public.permissions is a platform-global, immutable, non-secret capability contract keyed by the
-- stable text `key`. The Phase 2F management API introduces a read boundary over the catalog for the
-- authenticated workforce (business owner and authorized managers). Reading products requires a
-- dedicated capability that earlier phases never needed: prior order/inventory flows derived catalog
-- state through orders.* / inventory.* authorities, so no catalog.* key existed. This migration closes
-- that contract gap so future role governance can grant catalog reads.
--
-- This migration SEEDS THE CATALOG ONLY. It never assigns the permission to a Role and never creates a
-- role_permissions row: catalog provisioning is not the same act as granting, and there is deliberately
-- no default grant and no owner bypass. A Membership can read products only once a tenant explicitly
-- creates a Role carrying catalog.read, grants it, and scopes it. The insert is idempotent
-- (`on conflict (key) do nothing`), so re-applying it, or applying it after the key already exists, is a
-- no-op.

insert into public.permissions (key, description)
values
  ('catalog.read', 'Read products in the authorized brand scope.')
on conflict (key) do nothing;
