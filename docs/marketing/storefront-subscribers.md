# Storefront email sign-ups (SDK 0.47)

Phase 3 of the Storefront program. Shoppers leave an email in the website's "drop alerts" form; the
brand's owners and managers see the list in Admin Mobile (Website → Sign-ups).

## Data and write path

- Table `public.storefront_subscribers` (migration `20261119160000_storefront_subscribers`): `tenant_id`,
  optional `brand_id`, `email`, generated `normalized_email` (lower/trim), `source` (kebab-case, e.g.
  `home`), `created_at`. One row per address per tenant (`storefront_subscribers_tenant_email_unique`).
- The only writer is `online_private.subscribe_storefront_email(tenant, brand, email, source)`
  (SECURITY DEFINER, service_role only). It checks the tenant is active and the brand (if given) is an
  active brand of that tenant (`MK001` otherwise), inserts, and ignores duplicates. Clients cannot read
  the table; the server role can only `select` it.

## HTTP

| Method | Path                                    | SDK                     | Access                    |
| ------ | --------------------------------------- | ----------------------- | ------------------------- |
| POST   | `/api/v1/storefront/subscribe`          | `subscribeToStorefront` | public                    |
| GET    | `/api/v1/subscribers?limit=` (max 1000) | `listSubscribers`       | `orders.read` (any scope) |

The public response is always `{ subscribed: true }`, whether or not the address was already listed, so
it never reveals who signed up. `404 STOREFRONT_UNAVAILABLE` when the tenant/brand isn't an active
storefront. The list returns the newest sign-ups plus the tenant's `total`.

## Storefront

`/api/subscribe` (Storefront route) adds the server-side tenant/brand and forwards to the API. A hidden
honeypot field drops simple bots (they get the same success answer; nothing is stored).

## Testing

```bash
pnpm test:storefront:subscribers:persistence
```

Runs `supabase/tests/phase_4d_storefront_subscribers_persistence.sql`: privileges, case-insensitive
de-duplication, inactive/foreign tenant or brand rejection, and email/source checks. Unit tests:
`tests/marketing/subscribers.test.ts`.

## Known limitations

- No unsubscribe link or sending: the brand exports the list (Admin Mobile "Share list") into its own
  email tool. A welcome discount is not offered; that's an owner decision (a promotion code could be
  added to the confirmation later).
- No rate limiting beyond the honeypot; add an edge rate limit before heavy promotion.
