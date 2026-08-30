# Management API errors

Every non-2xx management response uses one frozen envelope:

```json
{
  "error": {
    "code": "STRING",
    "message": "safe message",
    "requestId": "uuid",
    "details": [{ "path": ["field"], "message": "safe validation message" }]
  }
}
```

- `code` is a stable machine token (e.g. `VALIDATION_ERROR`, `INVALID_CURSOR`, `SCOPE_DENIED`,
  `PERMISSION_DENIED`, `RESOURCE_NOT_FOUND`, `ORDER_NOT_FOUND`, `INTERNAL_ERROR`).
- `message` is a safe human string.
- `requestId` echoes the server-generated `X-Request-Id`.
- `details` is present **only** for request-validation failures and carries safe field-level messages.

The envelope never contains SQLSTATE, PostgreSQL text, constraint names, stack traces, or `service_role`
detail. Stable Order/Fulfillment codes pass through only where intentionally mapped.

## HTTP status contract

| Status | When                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- |
| 400    | request validation: bad UUID, bad query, bad cursor (`INVALID_CURSOR`), bad limit, bad tenant header |
| 401    | unauthenticated (missing/invalid session)                                                            |
| 403    | permission / scope / membership / tenant-status denial                                               |
| 404    | not found / safely invisible / tenant-contained explicit-filter miss                                 |
| 409    | state or idempotency conflict (existing domain codes)                                                |
| 422    | well-shaped domain-semantic rejection where the domain already uses 422                              |
| 500    | safe unexpected internal error                                                                       |

Notes:

- A foreign/nonexistent explicit filter (e.g. `products?brandId=<not in tenant>`) is **404**; an
  in-tenant but out-of-scope filter is **403**. The API does not rely on a tenant-access denial to
  synthesize a 404.
- A missing product/order (foreign or absent) is a safe **404**, never a scope-revealing 403.
- Response bodies are validated against the external contract before they are sent; an internal contract
  violation surfaces as a safe **500**, never as leaked data.
