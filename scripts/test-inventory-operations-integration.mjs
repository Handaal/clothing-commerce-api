// Phase 2C inventory-operations integration — restored on the per-run-isolated boundary (replaces stub).
// Real inventory repository against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2C inventory-operations integration",
  setupSql: ["phase_2c_inventory_operations.setup.sql"],
  vitest: {
    dir: "tests/inventory-integration",
    env: (status) => ({
      INVENTORY_TEST_SUPABASE_URL: status.API_URL,
      INVENTORY_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
