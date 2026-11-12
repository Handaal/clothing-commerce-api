// Phase 1D authorization integration — restored on the per-run-isolated boundary (replaces the stub).
// Real authorization repository against a disposable rt-<hex> DB; never touches the shared project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 1D authorization integration",
  setupSql: ["phase_1d_authorization_repository.setup.sql"],
  vitest: {
    dir: "tests/authorization-integration",
    env: (status) => ({
      AUTHORIZATION_TEST_SUPABASE_URL: status.API_URL,
      AUTHORIZATION_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    }),
  },
});
