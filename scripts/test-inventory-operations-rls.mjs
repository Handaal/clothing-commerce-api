// Phase 2C inventory-operations RLS — restored on the per-run-isolated boundary (replaces the stub).
// Runs the real pgTAP plan against a disposable rt-<hex> Supabase; never touches the shared dev project.
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2C inventory-operations RLS",
  rls: {
    files: ["supabase/tests/phase_2c_inventory_operations_rls.test.sql"],
    plans: [{ file: "phase_2c_inventory_operations_rls.test.sql", expected: 11 }],
  },
});
