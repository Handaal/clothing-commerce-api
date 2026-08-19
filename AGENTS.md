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
16. Documentation is part of the Definition of Done; every substantial change must update the relevant repository documentation before completion.

## Documentation Definition of Done

Any substantial task that introduces or changes component architecture, a dependency,
infrastructure, a script, configuration, an environment variable, a database or security
mechanism, a development workflow, or a deployment workflow must update the relevant documentation.

Document, where applicable:

1. purpose;
2. why the approach was selected;
3. how it works;
4. important architecture and data flow;
5. responsible files and directories;
6. commands;
7. configuration;
8. environment variables;
9. how to modify it safely;
10. how to test it;
11. how to troubleshoot it;
12. development versus production differences;
13. security considerations; and
14. known limitations.

Do not duplicate the same explanation across several files. Keep detailed guidance in the most
appropriate document and link to it from the root README or related architecture/operational guide.
