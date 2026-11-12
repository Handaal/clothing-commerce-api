// Phase 1C tenant RLS — restored on the per-run-isolated boundary (replaces the shared-CLI stub).
// Runs the real pgTAP plan against a disposable rt-<hex> Supabase; never touches the shared dev project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 1C tenant RLS",
  rls: {
    files: ["supabase/tests/phase_1c_b_tenant_rls.test.sql"],
    plans: [{ file: "phase_1c_b_tenant_rls.test.sql", expected: 87 }],
  },
});
