# SDK and Contract Strategy

Zod schemas in `src/contracts` are canonical. The OpenAPI 3.1 document is generated from those
schemas; a drift test compares the checked-in artifact with fresh generation. The SDK imports the
same schemas at build time and bundles them into a browser-compatible ESM/CJS package, preventing a
second hand-written definition.

Package: `@shifted/clothing-commerce-sdk`, current version `0.1.0`. It supports browsers, Electron
renderers, and Expo/React Native through standard `fetch` and has no Node-only runtime dependency.

Bootstrap validation uses `pnpm sdk:pack`, then copies the exact `.tgz` into each client's `vendor/`
directory. The client lockfile records the artifact and package version; no sibling checkout is
needed. Future releases publish to an approved private registry. PATCH means a compatible fix,
MINOR a backward-compatible addition, and MAJOR a breaking client/transport change.
