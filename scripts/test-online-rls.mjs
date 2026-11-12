// Phase 2L online RLS (+ shared tenant/catalog/inventory/orders/fulfillment RLS) — restored on the
// per-run-isolated boundary. Runs the full pgTAP set against a disposable rt-<hex> Supabase in one
// `supabase test db` invocation; never touches the shared dev project. Plan integrity is verified for
// every file before Docker starts (stronger than the original stub, which only checked phase_2l).
import { runIsolatedSupabaseSuite } from "./isolated-supabase-suite.mjs";

await runIsolatedSupabaseSuite({
  name: "Phase 2L online RLS + shared RLS set",
  rls: {
    files: [
      "supabase/tests/phase_2l_online_rls.test.sql",
      "supabase/tests/phase_1c_b_tenant_rls.test.sql",
      "supabase/tests/phase_2a_catalog_rls.test.sql",
      "supabase/tests/phase_2b_inventory_rls.test.sql",
      "supabase/tests/phase_2d_orders_rls.test.sql",
      "supabase/tests/phase_2e_fulfillment_rls.test.sql",
    ],
    plans: [
      { file: "phase_2l_online_rls.test.sql", expected: 20 },
      { file: "phase_1c_b_tenant_rls.test.sql", expected: 87 },
      { file: "phase_2a_catalog_rls.test.sql", expected: 43 },
      { file: "phase_2b_inventory_rls.test.sql", expected: 30 },
      { file: "phase_2d_orders_rls.test.sql", expected: 12 },
      { file: "phase_2e_fulfillment_rls.test.sql", expected: 14 },
    ],
  },
});
