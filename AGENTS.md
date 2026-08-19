# Commerce API Engineering Rules

1. TypeScript strict mode and zero TypeScript errors are mandatory.
2. This repository owns the commerce core, transport contracts, SDK, database schema, and migrations.
3. HTTP handlers validate inputs and outputs, coordinate application services, and translate to HTTP; keep them thin.
4. Business rules belong in explicit domain/application services, never clients or route handlers.
5. Zod schemas are the source of truth for transport shapes; generated OpenAPI and the SDK must not drift.
6. Never silently break `/api/v1`; follow the documented compatibility and deprecation policy.
7. Future tenant-owned records require explicit tenant isolation and deny-by-default database protection.
8. Tenant, brand, branch, warehouse, inventory location, and register remain distinct concepts.
9. POS and online use one product domain, inventory source, order domain, and customer domain.
10. Future inventory changes use an append-only movement ledger; clients never overwrite authoritative quantities.
11. Critical mutations require idempotency; payment webhooks are authoritative for asynchronous confirmation.
12. Database migrations are append-only and auditable. Never rewrite applied production history.
13. Server secrets never enter SDK artifacts or client-visible code.
14. Do not introduce microservices or change established boundaries without an ADR.
15. Run install, format, lint, typecheck, tests, and build for completed implementation work.
