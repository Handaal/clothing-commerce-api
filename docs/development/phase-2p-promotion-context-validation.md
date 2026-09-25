# Phase 2P Promotion Context Guidance Validation

The narrow compatibility patch adds optional `access.promotions: { canRead, canManage }` to
`GET /api/v1/me/context` and SDK `0.12.1`. Each boolean is derived independently from the caller's
effective tenant-wide `promotions.read` or `promotions.manage` grant. It is UI guidance only; existing
Promotion endpoints remain the authoritative authorization boundary.

The Zod response contract remains backward compatible because the new field is optional. OpenAPI is
regenerated from that contract, and the SDK continues to bundle the same schema. Focused tests cover no
grant, read-only, manage-only, explicit non-tenant scope denial, unchanged legacy access fields, exact
tenant filtering, old payload parsing, and the SDK response/type surface.

Validation commands:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm exec vitest run tests/promotions/context-guidance.test.ts packages/sdk/src/index.test.ts`
- `pnpm test:openapi`
- `pnpm build`
- `pnpm test:sdk` (run twice)

Artifact: `artifacts/shifted-clothing-commerce-sdk-0.12.1.tgz`

Deterministic SHA-256 (two independent packs):
`4fcd8076052cac6b4717b6eaa030a91f054398578cbbde9ceb69e7cfc819c7a0`

No database schema, migration, Promotion money logic, checkout, POS sale, Returns, POS client, or
Storefront client changed in this patch.
