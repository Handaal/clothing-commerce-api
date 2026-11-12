// Phase 2F management API integration — restored on the per-run-isolated boundary (replaces the stub).
// Real route handlers + Supabase RPC against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2F management API integration",
  setupSql: ["phase_2f_management.setup.sql"],
  vitest: {
    dir: "tests/api-integration",
    env: (status) => ({
      MGMT_TEST_SUPABASE_URL: status.API_URL,
      MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
