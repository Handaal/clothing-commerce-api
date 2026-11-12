// Phase 2D orders integration — restored on the per-run-isolated boundary (replaces the shared-CLI stub).
// Real orders repository against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2D orders integration",
  setupSql: ["phase_2d_orders.setup.sql"],
  vitest: {
    dir: "tests/orders-integration",
    env: (status) => ({
      ORDERS_TEST_SUPABASE_URL: status.API_URL,
      ORDERS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
