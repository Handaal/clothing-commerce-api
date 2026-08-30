# Management API pagination

## Envelope

List endpoints return:

```json
{
  "items": [/* … */],
  "pageInfo": { "nextCursor": "string | null", "hasMore": true }
}
```

- `limit` query parameter: default **25**, minimum **1**, maximum **100**. A bad limit is `400`.
- `hasMore` is derived with `LIMIT + 1`.
- `nextCursor` is `null` when there is no further page; otherwise it is the opaque cursor to pass as the
  next request's `cursor`.

## Cursors

A cursor is `base64url(JSON)`:

```json
{ "v": 1, "sort": "<literal>", "k": {/* keyset */} }
```

| Resource  | sort                   | keyset (`k`)                         | order                                       |
| --------- | ---------------------- | ------------------------------------ | ------------------------------------------- |
| Products  | `created_at_desc`      | `{ createdAt, id }`                  | `created_at DESC, id DESC`                  |
| Inventory | `location_variant_asc` | `{ inventoryLocationId, variantId }` | `inventory_location_id ASC, variant_id ASC` |
| Orders    | `placed_at_desc`       | `{ placedAt, id }`                   | `placed_at DESC, id DESC`                   |

Cursors are validated with Zod. A malformed token, wrong version, wrong sort, or wrong keys is
`400 INVALID_CURSOR`.

## Cursors carry no authorization

Cursors are **never signed or encrypted** and carry **no authorization**. Every page re-applies the
tenant + visibility predicate before the keyset condition and `LIMIT`, so a cursor only positions the
scan — it can never widen a caller's scope, resurface unauthorized rows, or cross a tenant. The
adversarial pagination test proves that page 1 and page 2 contain only authorized resources and that
each page is filled from authorized rows.

## Supporting indexes

Keyset order is served directly by additive indexes (see the migrations): `products_tenant_created_id_idx
(tenant_id, created_at DESC, id DESC)`, `inventory_balances_tenant_location_variant_idx (tenant_id,
inventory_location_id, variant_id)`, and `orders_tenant_placed_id_idx (tenant_id, placed_at DESC,
id DESC)`.
