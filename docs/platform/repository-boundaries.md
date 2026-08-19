# Repository Boundaries

- `clothing-commerce-api`: commerce rules, contracts, SDK release, integrations, and the only
  future database schema/migration ownership.
- `clothing-commerce-pos`: secure Electron sales-channel UI and future hardware/offline operational
  state. It never owns global truth.
- `clothing-commerce-storefront`: customer-facing Next.js sales channel. It owns presentation and
  SEO, not the central API or a business database.
- `clothing-commerce-admin-mobile`: Expo management channel. It is never a POS or shopper app.

Repositories exchange no source files, workspace links, submodules, or absolute-path dependencies.
The API contract, HTTPS, and a versioned SDK artifact are the stable integration surfaces.
