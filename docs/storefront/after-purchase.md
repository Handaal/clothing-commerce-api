# After purchase: tracking, confirmation, return requests (SDK 0.48)

Phase 4 of the Storefront program. Shoppers have no accounts, so an online order is identified by its
**order number plus the phone given at checkout** (customer or delivery phone).

## Data and write path

Migration `20261119200000_storefront_tracking_and_return_requests`:

- `public.storefront_lookup_failures` — one row per missed number + phone match. After **8 misses for one
  order number within 15 minutes**, lookups for that number answer `TR429` (checked before matching, so a
  correct guess during the lock is refused too). Private to the database; nothing reads it but the
  matcher. Trade-off: someone who knows an order number can lock its owner out of tracking for 15 minutes.
- `public.return_requests` + `public.return_request_lines` — a customer's request: lines (order line,
  quantity, reason), `preference` (`refund` | `exchange`), optional customer note, staff note, status
  (`requested` → `approved` | `declined`; `approved` → `completed` | `declined`), decider and time.
  Reference `<order number>-R<n>`. Written only by the functions below; the server role can only `select`.
- A request **moves no stock or money**. Online cash-on-delivery payments are never marked captured, so
  the staff returns flow (`accept_return`, which requires a captured payment) cannot refund them; staff
  handle the pickup/exchange themselves and mark the request completed. A completed request counts as
  returned (the larger of recorded returns and completed requests, so an item is never counted twice).
- Requests are accepted only when the tenant's `return_settings.enabled` is true, within
  `window_days` of `placed_at` (same rule as staff returns), for handed-over (fulfilled) units minus
  returned units minus units in open requests.

Functions (`online_private`, SECURITY DEFINER, `search_path = ''`):

| Function                                                                                                                        | Caller       | Purpose                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------- |
| `track_storefront_order(tenant, brand, reference, phone)`                                                                       | service_role | tracking JSON or null            |
| `request_storefront_return(tenant, brand, reference, phone, preference, note, lines)`                                           | service_role | `{request}` or `{refusal}`       |
| `list_return_requests(tenant, status, order, limit)`                                                                            | service_role | staff list                       |
| `set_return_request_status(tenant, request, actor, status, note)`                                                               | service_role | staff decision (`RQ404`/`RQ409`) |
| `match_storefront_order`, `order_line_return_state`, `return_request_refusal`, `return_request_json`, `readable_option_summary` | internal     | helpers                          |

`readable_option_summary` turns the order line's option snapshot (comma-separated option value ids) into
names ("S · Sky Blue") for tracking and requests. Admin order detail still shows the raw snapshot.

## HTTP

| Method | Path                                              | SDK                         | Access                                               |
| ------ | ------------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| POST   | `/api/v1/storefront/orders/track`                 | `trackStorefrontOrder`      | public                                               |
| POST   | `/api/v1/storefront/return-requests`              | `requestStorefrontReturn`   | public                                               |
| GET    | `/api/v1/return-requests?status=&orderId=&limit=` | `listReturnRequests`        | `returns.read` (any scope)                           |
| POST   | `/api/v1/return-requests/{id}/status`             | `updateReturnRequestStatus` | `returns.create` on the order brand, Idempotency-Key |

Tracking is POST so the phone never lands in a URL or access log. Errors: `ORDER_NOT_FOUND` (404, wrong
number or phone), `TOO_MANY_ATTEMPTS` (429), `RETURNS_DISABLED` / `ORDER_CANCELLED` /
`RETURN_WINDOW_EXPIRED` / `NOT_YET_DELIVERED` / `NOTHING_TO_RETURN` (422), `RETURN_QUANTITY_EXCEEDED`
(409), `INVALID_RETURN_REQUEST` (400). Tracking shows the stage (`confirmed`, `partially_shipped`,
`shipped`, `delivered` once payment is captured, `cancelled`), lines, totals, first name and city only.

## Confirmation messages (free)

No messages are sent by a server. The SDK builds the text and click-to-chat links
(`orderConfirmationMessage`, `customerOrderConfirmMessage` in English/Arabic, `whatsAppLink`, `smsLink`):

- Storefront order confirmation: "Confirm on WhatsApp" (shopper → store, needs
  `STOREFRONT_WHATSAPP_NUMBER`) and "Track your order".
- Admin Mobile online order: "Send confirmation on WhatsApp / by SMS" (staff → customer, opens on the
  staff phone). Includes the tracking link when `EXPO_PUBLIC_STOREFRONT_URL` is set.
- POS Online orders: "Send confirmation on WhatsApp" (WhatsApp desktop/web).

Automatic sending (WhatsApp Business API or an SMS gateway) is not built; it needs a paid provider.

Tests: `pnpm test:storefront:tracking:persistence` (database), `tests/orders/after-purchase.test.ts`,
`packages/sdk/src/messages.test.ts`.
