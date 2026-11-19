# Storefront delivery fees (Storefront program, Phase 1B)

## Purpose

Charge online customers a delivery fee that depends on where the order goes, as Egyptian fashion stores
do: one fee per governorate, with optional free delivery above an order value. Admins set the areas and
fees; checkout charges them; the fee is part of what the courier collects (COD).

## How it works

Migration `supabase/migrations/20261119130000_storefront_delivery_fees.sql`:

- `public.storefront_delivery_zones` — per brand: `code` (upper-case, e.g. `EG-C` for Cairo), `name`,
  `fee_minor`, `position`, `active`. Written only by `settings_private.write_storefront_delivery`
  (replace-all, idempotent); read by checkout (`online_writer`).
- `storefront_checkout_settings.free_delivery_threshold_minor` — optional; when the goods total after
  discount reaches it, delivery is free.
- `orders.delivery_fee_minor` — the charged fee. **The order identity is now**
  `total_minor = gross_subtotal_minor - discount_total_minor + delivery_fee_minor`, so the order total,
  the COD payment amount and what the shopper sees are one number. POS orders always have 0.

Checkout flow (`online_private.place_checkout`): resolve lines → create order → redeem promotion (fee is 0
at this point, so promotions discount goods only) → `online_private.delivery_charge` → apply the fee with
`orders_private.apply_delivery_fee` (owned by `orders_writer`, the only fee writer) → compare with the
client's `expectedTotalMinor` (stale → `PRICE_CHANGED` with the real total) → reserve stock → COD payment.

Rules (`delivery_charge`):

| Brand has active zones? | `zoneCode`       | Result                                                                                 |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| No                      | any/none         | fee 0 (pre-1B behaviour)                                                               |
| Yes                     | none             | quote: `delivery.required = true`, fee unknown; placement: `DELIVERY_ZONE_UNAVAILABLE` |
| Yes                     | unknown/inactive | `DELIVERY_ZONE_UNAVAILABLE` (422)                                                      |
| Yes                     | active           | zone fee, or 0 with `freeApplied` when the threshold is reached                        |

## HTTP and SDK (0.45.0)

| Method  | Path                                                                                           | SDK                                                                  |
| ------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| GET     | `/api/v1/storefront/delivery?tenantId&brandId` (public)                                        | `getStorefrontDeliveryOptions`                                       |
| POST    | `/api/v1/storefront/quote` (+ optional `zoneCode`; response `delivery`)                        | `quote`                                                              |
| POST    | `/api/v1/storefront/checkout` (`delivery.zoneCode`; result `deliveryFeeMinor`, `deliveryZone`) | `checkout`                                                           |
| GET/PUT | `/api/v1/settings/storefront/{brandId}/delivery` (settings.read / settings.manage)             | `getStorefrontDeliverySettings` / `updateStorefrontDeliverySettings` |

Order reads expose the fee: list items `deliveryFeeMinor`; online order detail `commerce.deliveryFeeMinor`.

## Testing

```bash
pnpm test:storefront:delivery:persistence
```

`supabase/tests/phase_4b_storefront_delivery_fees_persistence.sql` on a disposable database: privileges,
unconfigured brands stay free, zone settings replay/ID409/duplicates, quotes (required, fee, free threshold,
inactive zone), placement (required/unknown zone, stale total, fee in order + payment, snapshot, replay,
guard), POS untouched, and the total identity on every order.

Local data: `supabase/dev/seed-storefront-delivery.sql` enables COD and seeds Egypt's 27 governorates
(test fees) for every dev brand with published products.

## Known limitations

- Reporting "net" sums `total_minor`, so it includes delivery fees for online orders until reporting gets a
  separate delivery figure.
- Returns refund goods only; the delivery fee is never refunded automatically.
- One fee per zone (no weight/size-based pricing, no per-city fees inside a governorate).
