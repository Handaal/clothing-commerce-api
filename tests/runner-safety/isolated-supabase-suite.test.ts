// DB-free tests for the reusable isolated-suite harness that restores the formerly shared-CLI
// RLS/integration runners. They prove: (a) a spec with no target is rejected BEFORE any stack/Docker is
// touched; (b) pgTAP plan integrity is verified BEFORE a stack is created, so a tampered/weakened plan
// aborts the run; (c) the Supabase service-exclusion set is correct per suite type. The isolation
// primitives the harness reuses (rt-<hex> minting, arg guard, env sanitation, ownership cleanup) are
// covered by supabase-isolation-guard.test.ts. Nothing here starts Docker or reaches a database.
import { describe, expect, it } from "vitest";

import {
  EXCLUDE_DB_ONLY,
  EXCLUDE_KEEP_API,
  runIsolatedSupabaseSuite,
  selectExcluded,
  verifyPgtapPlan,
} from "../../scripts/isolated-supabase-suite.mjs";

describe("selectExcluded — service set per suite type", () => {
  it("keeps the API layer (Kong/PostgREST/GoTrue) up for vitest integration suites", () => {
    const excluded = selectExcluded({ vitest: { dir: "x", env: () => ({}) } });
    expect(excluded).toBe(EXCLUDE_KEEP_API);
    for (const service of ["kong", "postgrest", "gotrue"])
      expect(excluded.split(",")).not.toContain(service);
  });
  it("drops the API layer for pure in-DB pgTAP RLS suites", () => {
    const excluded = selectExcluded({ rls: { files: [] } });
    expect(excluded).toBe(EXCLUDE_DB_ONLY);
    for (const service of ["kong", "postgrest", "gotrue"])
      expect(excluded.split(",")).toContain(service);
  });
  it("honors an explicit override", () => {
    expect(selectExcluded({ excluded: "only-this", rls: { files: [] } })).toBe("only-this");
  });
});

describe("verifyPgtapPlan — plan integrity gate", () => {
  it("accepts a real RLS plan at its known assertion count", () => {
    expect(() => verifyPgtapPlan("phase_2d_orders_rls.test.sql", 12)).not.toThrow();
    expect(() => verifyPgtapPlan("phase_2l_online_rls.test.sql", 20)).not.toThrow();
  });
  it("rejects a plan whose declared count was changed (anti weakening)", () => {
    expect(() => verifyPgtapPlan("phase_2d_orders_rls.test.sql", 99)).toThrow(
      /expected a 99-assertion pgTAP plan, found 12/,
    );
  });
  it("rejects a missing plan file rather than silently passing", () => {
    expect(() => verifyPgtapPlan("does-not-exist.test.sql")).toThrow();
  });
});

describe("runIsolatedSupabaseSuite — aborts before any stack/Docker when the spec is unsafe", () => {
  it("rejects a spec that declares neither an rls nor a vitest target", async () => {
    // Validation happens before createIsolatedStack (which is the only place Docker/resources are touched),
    // so this rejects without minting a project or issuing a single docker/supabase command.
    await expect(runIsolatedSupabaseSuite({ name: "empty" })).rejects.toThrow(
      /must declare an rls and\/or vitest target/,
    );
  });
  it("rejects BEFORE stack creation when a declared pgTAP plan no longer matches", async () => {
    await expect(
      runIsolatedSupabaseSuite({
        name: "tampered",
        rls: {
          files: ["supabase/tests/phase_2d_orders_rls.test.sql"],
          plans: [{ file: "phase_2d_orders_rls.test.sql", expected: 999 }],
        },
      }),
    ).rejects.toThrow(/expected a 999-assertion pgTAP plan/);
  });
});
