// Phase 2G inventory-write integration — restored on the per-run-isolated boundary (replaces the stub).
// Real inventory-write repository against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2G inventory-write integration",
  setupSql: ["phase_2g_inventory_write.setup.sql"],
  vitest: {
    dir: "tests/inventory-write-integration",
    env: (status) => ({
      MGMT_TEST_SUPABASE_URL: status.API_URL,
      MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
