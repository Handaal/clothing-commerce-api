# SDK consumption and handoff

`@shifted/clothing-commerce-sdk` is the validated, platform-neutral client for the Clothing Commerce API.
See [ADR-036](../decisions/ADR-036-sdk-distribution-and-consumption.md).

## Version

`0.2.0` — additive over `0.1.0` (management contracts and methods). The root package version is
unchanged.

## Client shape

```ts
import { createCommerceClient } from "@shifted/clothing-commerce-sdk";

const client = createCommerceClient({
  baseUrl: "https://api.example.com",
  client: { type: "admin-mobile", version: "1.0.0" },
  getToken: async () => clerk.session?.getToken() ?? null, // Clerk user/session-token seam
});

// Identity bootstrap (no tenant context, no X-Tenant-Id):
const tenants = await client.getMyTenants();

// Immutable per-tenant context:
const tenant = client.withTenant(tenants[0].tenantId);
const context = await tenant.getContext();
const products = await tenant.listProducts({ brandId, limit: 25 });
const nextPage = await tenant.listProducts({ cursor: products.pageInfo.nextCursor ?? undefined });
const inventory = await tenant.listInventory({ inventoryLocationId });
const orders = await tenant.listOrders({ channel: "pos" });
const order = await tenant.getOrder(orderId);
```

The SDK uses standard `fetch`, sends `Authorization`, `X-Tenant-Id`, `X-Client-Type`, and
`X-Client-Version`, parses the external error envelope into typed errors (`ApiHttpError` with `status`,
`code`, `requestId`; `ApiNetworkError`; `ApiContractError`), and returns the paginated contract. Tenant
context is immutable per client (`withTenant`), never a hidden mutable global. The SDK never owns Clerk
UI/session and never accepts service-role credentials.

## Packaging and distribution

The SDK bundles the shared contract validators from the API source into the published package (tsup; no
OpenAPI codegen). `zod` is declared as the SDK's single runtime dependency — the public declarations
(`dist/index.d.ts`) import `zod`, so a consumer must be able to resolve it; declaring it means the
consumer's package manager installs it transitively from the tarball with no manual setup. A post-build
step strips esbuild's module-path banner comments so the tarball references no `../../src` in substance
or text. After installation the package requires no API-repo source, workspace resolution, or sibling
paths — only its declared `zod` dependency.

`pnpm sdk:pack` produces:

```
artifacts/shifted-clothing-commerce-sdk-0.2.0.tgz
```

- **Filename:** `shifted-clothing-commerce-sdk-0.2.0.tgz`
- **Version:** `0.2.0`
- **SHA256 (this build):** `764a5b756ff549e3dc01faf1d82f8bc6cb654cfd0889b2c7d7728afca59f6e3b`

Recompute the checksum against the frozen artifact with `pnpm sdk:pack` then
`sha256sum artifacts/shifted-clothing-commerce-sdk-0.2.0.tgz`. The exact frozen value is recorded at
handoff; the tarball must not be overwritten with different contents once frozen.

`pnpm test:sdk` builds, typechecks, unit-tests, packs, and then — in a genuinely isolated temp project
outside the repo — installs ONLY the tarball (never installing `zod` manually), asserts the packed
manifest declares its `zod` runtime dependency, asserts the tarball has no `../../src`/workspace
references, imports it via both ESM and CJS, and runs a strict `skipLibCheck: false` TypeScript typecheck
against the public types so a future missing declaration dependency fails the gate.

## Phase 2F-B vendor-copy procedure (not performed in 2F-A)

Phase 2F-A does **not** copy the tarball into Admin Mobile. Phase 2F-B will:

1. Copy the exact versioned tarball into `clothing-commerce-admin-mobile/vendor/`.
2. Commit the tarball in the **mobile** repo.
3. Reference it with a relative dependency:

   ```json
   {
     "dependencies": {
       "@shifted/clothing-commerce-sdk": "file:vendor/shifted-clothing-commerce-sdk-0.2.0.tgz"
     }
   }
   ```

No absolute machine path, sibling source import, workspace dependency, or git submodule is used. A
future private registry can replace the vendored tarball without changing consumer code.
