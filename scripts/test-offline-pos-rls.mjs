// RETIRED (2026-11-08) — this runner targeted the SHARED dev Supabase project `clothing-commerce-api`
// (no `--workdir`) and finished with `supabase stop --no-backup`, the exact Phase 2M data-loss path
// (docs/development/phase-2m-test-isolation.md). Replaced by an isolated, disposable, ownership-proven
// runner. Fail closed so it can never destroy the shared project again.
throw new Error(
  "test-offline-pos-rls.mjs is retired (shared-project destructive path). " +
    "Use: node scripts/test-offline-pos-isolated.mjs --rls-only  (10-assertion pgTAP plan on a disposable rt-<hex> DB). " +
    "See docs/development/supabase-local.md and the offline-first roadmap §9.",
);
