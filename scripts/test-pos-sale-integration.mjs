// Phase 2H POS sale integration — restored on the per-run-isolated boundary (replaces the shared-CLI stub).
// Real connected-sale repository against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2H POS sale integration",
  setupSql: ["phase_2h_pos_sale.setup.sql"],
  vitest: {
    dir: "tests/pos-sale-integration",
    env: (status) => ({
      POS_TEST_SUPABASE_URL: status.API_URL,
      POS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
