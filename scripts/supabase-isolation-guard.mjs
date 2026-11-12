// Fail-closed isolation guard for destructive Supabase/database test runners.
//
// BACKGROUND: a family of integration/RLS runners drove the Supabase CLI (`supabase start` /
// `db reset --local` / `stop --no-backup`) with `cwd: <repoRoot>` and NO `--workdir`/`--project-id`, so
// the CLI resolved the repo `config.toml` and targeted the SHARED dev project `clothing-commerce-api`. On
// a developer machine where that project holds real data, `db reset` + `stop --no-backup` DESTROYS it —
// the Phase 2M data-loss incident (docs/development/phase-2m-test-isolation.md).
//
// POLICY (this task): there is NO safe "run against the shared/default project" mode and NO environment
// flag that re-enables one. A destructive runner must EITHER create its own disposable, ownership-proven
// `rt-<hex>` project (see returns-test-resources.mjs) and pin every CLI/Docker call to it, OR fail closed.
// This module provides:
//   - failClosedLegacyRunner(): the hard stop for any runner that still resolves the shared/default
//     project. It throws unconditionally — no docker probe, no env opt-in, no shared fallback.
//   - assertIsolatedSupabaseArgs(): a static argv guard the ISOLATED runners self-apply, so a destructive
//     CLI call can never be issued without a disposable `--workdir` (and never against the shared id).
//   - assertNotSharedProject(): asserts a project id is a disposable `rt-<hex>`, never the shared/default.
//   - assertLoopbackDbHost(): asserts a DB/API host is loopback before any migration/fixture/test write.
//   - sanitizedChildEnv(): strips inherited `.env`/`POS_TEST_*`/`SUPABASE_*`/`PG*`/connection-string
//     variables from a child-process env so nothing can silently redirect the API/test process back to a
//     shared database; only the explicit isolated overrides survive.
import { spawnSync } from "node:child_process";

export const SHARED_PROJECT_ID = "clothing-commerce-api";
export const SHARED_DB_CONTAINER = "supabase_db_clothing-commerce-api";
// A disposable run's project id. returns-test-resources.mjs mints exactly this shape.
export const ISOLATED_PROJECT_PATTERN = /^rt-[a-f0-9]{32}$/;

function defaultDockerExec(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0)
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed (${result.status ?? "none"})`);
  return result.stdout ?? "";
}

/**
 * Names of any container (running or stopped) belonging to the shared dev project. Read-only; used by the
 * isolated runners/tests to ASSERT they are not about to collide with the shared stack. Never used to
 * decide whether a destructive command is "safe" — the shared project being down is not a licence to run.
 * @param {(args: string[]) => string} dockerExec injectable for tests; defaults to the real docker CLI.
 */
export function liveSharedContainers(dockerExec = defaultDockerExec) {
  const out = dockerExec([
    "ps",
    "-a",
    "--filter",
    `label=com.supabase.cli.project=${SHARED_PROJECT_ID}`,
    "--format",
    "{{.Names}}",
  ]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Hard stop for a legacy runner whose destructive path resolves the shared/default project. Throws
 * unconditionally: there is no docker probe and no environment opt-in, so the shared dev database can
 * never be reset/stopped by this runner again, regardless of host state or inherited env.
 * @param {string} runner the de-advertised script name, for the error message.
 * @param {{ replacement?: string }} [options] the isolated runner to use instead.
 * @returns {never}
 */
export function failClosedLegacyRunner(runner, options = {}) {
  const replacement =
    options.replacement ??
    "an isolated runner built on scripts/returns-test-resources.mjs (unique rt-<hex> project pinned with --workdir)";
  throw new Error(
    `Refusing to run ${runner}: its destructive path (supabase start / db reset / stop --no-backup with no ` +
      `--workdir) resolves the SHARED dev project '${SHARED_PROJECT_ID}' from the repo config and would ` +
      `DESTROY it (Phase 2M incident). This runner is DISABLED and de-advertised (removed from test:all + CI). ` +
      `There is no shared-reset bypass. Use ${replacement}. See docs/development/supabase-local.md and ` +
      `docs/development/phase-2m-test-isolation.md for the migration path.`,
  );
}

/**
 * Static argv guard the ISOLATED runners self-apply before spawning the Supabase CLI. Rejects any
 * destructive subcommand that is not pinned to a disposable `--workdir`, or that explicitly names the
 * shared project. Pure arg inspection; no side effects.
 * @param {string[]} args the supabase CLI argv (without the node/entrypoint prefix)
 * @param {{ repoRoot: string }} context
 */
export function assertIsolatedSupabaseArgs(args, { repoRoot }) {
  const joined = args.join(" ");
  const destructive =
    args.includes("start") ||
    args.includes("stop") ||
    (args.includes("db") && (args.includes("reset") || args.includes("push")));
  if (!destructive) return;
  const workdirIndex = args.indexOf("--workdir");
  const workdir = workdirIndex >= 0 ? args[workdirIndex + 1] : undefined;
  const projectIndex = args.indexOf("--project-id");
  const projectId = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
  if (projectId === SHARED_PROJECT_ID)
    throw new Error(
      `Refusing destructive Supabase command explicitly targeting '${SHARED_PROJECT_ID}'.`,
    );
  if (workdir === undefined || workdir === repoRoot)
    throw new Error(
      `Refusing destructive Supabase command without an isolated --workdir (got: ${joined}). ` +
        `Destructive commands must be pinned to a disposable workdir, never the repo root/default config.`,
    );
}

/**
 * Assert a project id is a disposable per-run `rt-<hex>` id, never the shared/default project. The
 * isolated runners call this immediately after minting their id and before any CLI/Docker call.
 * @param {string} projectId
 */
export function assertNotSharedProject(projectId) {
  if (projectId === SHARED_PROJECT_ID)
    throw new Error(`Refusing to operate on the shared project '${SHARED_PROJECT_ID}'.`);
  if (!ISOLATED_PROJECT_PATTERN.test(projectId ?? ""))
    throw new Error(
      `Refusing to operate on a non-disposable project id '${projectId}'. ` +
        `Isolated runs must use an rt-<32 hex> project from returns-test-resources.mjs.`,
    );
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/**
 * Assert a DB/API host is loopback. Called before migrations, resets, fixtures, and test writes so a
 * mis-resolved status/URL can never point the mutation at an external/shared database.
 * @param {string} host a hostname (not a URL). Callers pass `new URL(x).hostname`.
 * @param {string} [label] what the host is, for the error.
 */
export function assertLoopbackDbHost(host, label = "database") {
  if (!LOOPBACK_HOSTS.has(String(host)))
    throw new Error(
      `Refusing to use a non-loopback ${label} host '${host}'. Isolated runs must target 127.0.0.1/localhost only.`,
    );
}

// Inherited variables that could silently redirect the API/test process to another (possibly shared)
// database. Stripped from every isolated child env; the runner then re-adds ONLY its disposable values.
const REDIRECTOR_PREFIXES = ["SUPABASE_", "POSTGRES_", "PG", "POS_TEST_"];
const REDIRECTOR_EXACT = new Set([
  "DATABASE_URL",
  "DB_URL",
  "SUPABASE_DB_URL",
  "DIRECT_URL",
  "DIRECT_DATABASE_URL",
  "SUPABASE_ALLOW_SHARED_RESET", // removed bypass: never honor it even if present in the environment
]);

/**
 * Build a child-process env from the parent, with inherited database-redirecting variables removed, then
 * apply the caller's explicit isolated overrides last. This guarantees a stray `.env`, a legacy
 * `POS_TEST_SUPABASE_URL`, or a developer's exported `DATABASE_URL` cannot point the spawned API/test
 * process at a shared database — only the disposable values the isolated runner sets survive.
 * @param {Record<string,string|undefined>} overrides disposable values to set (isolated URL/keys/etc).
 * @param {Record<string,string|undefined>} [base] the parent env; defaults to process.env.
 */
export function sanitizedChildEnv(overrides = {}, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (REDIRECTOR_EXACT.has(key)) continue;
    if (REDIRECTOR_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
