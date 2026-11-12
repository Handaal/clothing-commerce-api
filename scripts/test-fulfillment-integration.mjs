// Phase 2E fulfillment integration — restored on the per-run-isolated boundary (replaces the stub).
// Real fulfillment repository against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2E fulfillment integration",
  setupSql: ["phase_2e_fulfillment.setup.sql"],
  vitest: {
    dir: "tests/fulfillments-integration",
    env: (status) => ({
      FULFILLMENT_TEST_SUPABASE_URL: status.API_URL,
      FULFILLMENT_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
