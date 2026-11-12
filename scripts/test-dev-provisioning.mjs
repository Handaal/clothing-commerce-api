// DISABLED — NOT YET SAFELY ISOLATABLE (true per-run isolation task, 2026-11-08).
//
// This suite spawns scripts/provision-dev-identity.mjs, which is HARDCODED to the shared dev container
// `supabase_db_clothing-commerce-api` (databaseContainerName) and resolves `supabase status` for the
// default project. Pointing the vitest process at a disposable rt-<hex> DB does NOT redirect that spawned
// script: it would apply supabase/dev/provision-dev-identity.sql to the SHARED project while the test
// asserts against the isolated DB — the assertions then fail AND the shared project is written to. It is
// therefore left fail-closed rather than pretend-isolated.
//
// To restore safely: parameterize the dev scripts (provision-dev-identity.mjs / provision-dev-commerce-
// fixture.mjs) to accept the disposable container + loopback API URL (e.g. COMMERCE_DEV_DB_CONTAINER /
// COMMERCE_DEV_API_URL), keep their fail-closed locality guard, and have the integration tests forward
// those from the isolated runner. Only then re-enable this on scripts/isolated-supabase-suite.mjs.
import { failClosedLegacyRunner } from "./supabase-isolation-guard.mjs";

failClosedLegacyRunner("test:dev:provisioning", {
  replacement:
    "parameterize scripts/provision-dev-identity.mjs for a disposable container + loopback API, then run it on scripts/isolated-supabase-suite.mjs (see this file's header)",
});
