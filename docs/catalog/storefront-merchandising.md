# Storefront merchandising: sales, offers, home-page content

Lets a business's owners/managers, from Admin Mobile, (1) put items on sale, (2) run Buy-X-Get-Y
offers, and (3) edit the Storefront home page (hero image/text, featured products and collections).
Migration: `supabase/migrations/20261113120000_storefront_merchandising.sql`. SDK **0.29.0**.

## 1. Catalog sales

A **sale** is a per-unit **online** price reduction:

- benefit: percentage (`benefitPercentBp`, 1–10000) **or** fixed amount per item
  (`benefitAmountMinor` + `benefitCurrency`);
- scope: `all` products, one `collection`, or selected `products`;
- optional `startsAt` / `endsAt`; persisted status `active` / `inactive` (scheduled/ended are derived).

**Why a price layer and not a promotion.** The promotion engine applies exactly **one** promotion per
order (ADR-037). If sales were promotions, two items on two different sales could not both show and
charge their sale price. Sales instead change the **unit price** that `online_private.resolve_line`
resolves, so the Storefront catalog display, the non-consuming quote, and the idempotent checkout all
charge the same server-authoritative figure, and order lines snapshot the charged (sale) price as before.
Promotions/codes still apply on top of sale-priced lines. Returns refund the paid line price unchanged.

**Selection.** `catalog_private.effective_unit_price(tenant, product, currency, list)` returns the
**lowest** price among live matching sales (never stacked). Percentage floors the discount
(`list − floor(list × bp / 10000)`); fixed never goes below zero and only matches its own currency.

**Public contract.** `PublicProductPrice.amountMinor` is now the price the shopper pays (sale-adjusted);
new optional `compareAtAmountMinor` is the original list price when on sale (null otherwise). Older
clients that ignore the new field keep charging correctly because `amountMinor` already equals the
checkout figure.

**POS is unaffected** — connected and offline POS keep list prices.

| Endpoint                              | Auth                                                    |
| ------------------------------------- | ------------------------------------------------------- |
| `GET/POST /api/v1/sales`              | `promotions.read` / `.manage` + Idempotency-Key on POST |
| `GET/PATCH/DELETE /api/v1/sales/{id}` | `promotions.read` / `.manage`                           |
| `POST /api/v1/sales/{id}/status`      | `promotions.manage`                                     |

DB errors: `SL404` → `SALE_NOT_FOUND` (404); `SL422` → `INVALID_SALE` (422).

## 2. Buy-X-Get-Y offers

New promotion `benefitType: "buy_x_get_y"` with `buyQuantity` / `getQuantity` (1–100). For every
complete group of `buy + get` qualifying units (whole order, or the targeted products/variants) the
cheapest `get` units are free (`promotions_private.bxgy_discount`). Everything else is the existing
engine: one promotion per order (greatest saving wins), min-subtotal / max-discount / window /
redemption caps, largest-remainder line allocation, net-basis returns.

Offers are **online-only** (DB constraint + create function force `channel = 'online'`). That keeps
older POS SDKs, whose `AppliedPromotion.benefitType` enum predates this value, from ever receiving it.
Live automatic offers are surfaced on the public product as `offers: [{id, name, buyQuantity,
getQuantity}]` for badges.

## 3. Storefront home-page content

One `public.storefront_content` row per tenant: hero (`eyebrow`, `title`, `subtitle`, `ctaLabel`,
`ctaHref`, `image`), `featuredHeading`, ordered `featuredProductIds` (≤24) and
`featuredCollectionIds` (≤12). Structured content only — the Storefront owns layout.

| Endpoint                                            | Auth                                                   |
| --------------------------------------------------- | ------------------------------------------------------ |
| `GET/PUT /api/v1/storefront-content`                | `catalog.author` (PUT + Idempotency-Key, full replace) |
| `POST /api/v1/storefront-content/hero-image-intent` | `catalog.author`                                       |
| `GET /api/v1/storefront/content?tenantId=&brandId=` | public                                                 |

Safety: featured ids must belong to the tenant (`SC422`); `ctaHref` must be an internal path or
`https://` (DB check); the hero image must sit under `<tenantId>/storefront/` in `product-media`
(service + DB check). The public projection returns only publicly visible products/collections in the
curated order; `hero` is `null` until content is saved, and the Storefront then uses its defaults.

**Image upload.** The intent returns a server-chosen path and, via the new
`createSupabaseMediaUploadSigner` (`src/merchandising/storage-signer.ts`), a signed Storage upload URL.
The same signer is now wired into product media intents, which previously always returned
`uploadUrl: null`. When Storage is unreachable the signer returns `null` (documented contract).

## Boundary

Tables have RLS with no policies; `service_role` has SELECT only and writes through the
`SECURITY DEFINER` functions in `catalog_private`. `online_writer` gets EXECUTE on
`effective_unit_price` only.

## Testing

- `pnpm test` — contract, shaper, service and error-mapping unit tests (`tests/merchandising`).
- SQL money smoke test (rolled back; needs a published priced product):
  `docker exec -i supabase_db_clothing-commerce-api psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/storefront_merchandising.smoke.sql`
  covers sale pricing, lowest-wins, inactive sales, quote charging, Buy-2-Get-1, POS exclusion, offer
  badges, content round trip and link/image/id validation.

## Known limitations

- Sales do not snapshot the original list price on order lines (reports see the charged price).
- Not yet in the isolated two-cycle persistence suites (`pnpm test:promotions:persistence`).
- Offer quantities are fixed after creation; there is no per-customer limit (same as promotions V1).
