// RETIRED (2026-11-08) — this runner targeted the SHARED dev Supabase project `clothing-commerce-api`
// (hardcoded container, no `--workdir`) and finished with `supabase stop --no-backup`, the exact Phase 2M
// data-loss path (docs/development/phase-2m-test-isolation.md). It is replaced by an isolated,
// disposable, ownership-proven runner. Fail closed so it can never destroy the shared project again.
throw new Error(
  "test-offline-pos-integration.mjs is retired (shared-project destructive path). " +
    "Use: node scripts/test-offline-pos-isolated.mjs  (RLS + in-process integration on a disposable rt-<hex> DB) " +
    "or node scripts/test-offline-pos-http-isolated.mjs  (full HTTP-server path). " +
    "See docs/development/supabase-local.md and the offline-first roadmap §9.",
);
