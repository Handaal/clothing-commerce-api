// Phase 2J catalog-management integration — restored on the per-run-isolated boundary (replaces stub).
// Real catalog-management repository against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2J catalog-management integration",
  setupSql: ["phase_2j_catalog.setup.sql"],
  vitest: {
    dir: "tests/catalog-management-integration",
    env: (status) => ({
      MGMT_TEST_SUPABASE_URL: status.API_URL,
      MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
