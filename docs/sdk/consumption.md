# SDK consumption and handoff

`@shifted/clothing-commerce-sdk` is the validated, platform-neutral client for the Clothing Commerce
API. Version `0.4.0` adds typed Connected POS methods while preserving the existing management and
inventory surface.

```ts
import { createCommerceClient } from "@shifted/clothing-commerce-sdk";

const client = createCommerceClient({
  baseUrl: "https://api.example.com",
  client: { type: "pos-desktop", version: "1.0.0" },
  getToken: async () => clerk.session?.getToken() ?? null,
});

const tenant = client.withTenant(tenantId);
const context = await tenant.getPosContext();
const sale = await tenant.createPosSale({
  idempotencyKey: crypto.randomUUID(),
  registerId: context.registers[0].registerId,
  expectedTotalMinor: 5198,
  cashReceivedMinor: 6000,
  lines: [{ variantId, quantity: 2 }],
});
```

The SDK calls the configured token provider, owns `X-Tenant-Id`, sends the caller's sale key as the
`Idempotency-Key` header, and validates both successful and error responses. The body never carries
branch, inventory location, currency, unit price, payment amount, or idempotency key. A
`PRICE_CHANGED` `ApiHttpError` exposes the new total in `details[0].value`.

The SDK uses standard `fetch`, contains no Clerk UI/session implementation, and never accepts a
service-role credential. Existing methods such as `getMyTenants`, `getContext`, `listProducts`,
`listInventory`, the inventory writes, `listOrders`, and `getOrder` remain available.

## Packaging and verification

The API repository is the release owner. `zod` remains the single declared runtime dependency because
the public declarations import its types. The build bundles shared validators and strips repository
path banners; no workspace or sibling-source reference is published.

```text
artifacts/shifted-clothing-commerce-sdk-0.4.0.tgz
```

Run `pnpm test:sdk` to typecheck, build, unit-test, and pack the SDK, then install only that tarball in
an isolated temporary project. The gate proves ESM import, CJS require, strict TypeScript consumption
with `skipLibCheck: false`, and transitive `zod` resolution. Compute the frozen artifact checksum with:

```powershell
Get-FileHash artifacts/shifted-clothing-commerce-sdk-0.4.0.tgz -Algorithm SHA256
```

The final Phase 2H handoff records the resulting SHA256. Do not overwrite a released artifact with
different bytes; publish a new semantic version instead. Consumer repositories should vendor the
versioned tarball or use the approved private registry—never an absolute path, workspace dependency,
or source import.

See [Connected POS Sale V1](../pos/connected-pos-sale-v1.md) for transaction, cash, price-change,
authorization, idempotency, tax, and device-trust semantics, and
[ADR-036](../decisions/ADR-036-sdk-distribution-and-consumption.md) for distribution ownership.
