// Reusable per-run-isolated Supabase suite harness.
//
// WHY THIS EXISTS: a family of RLS/integration runners drove the Supabase CLI (`supabase start` /
// `db reset --local` / `stop --no-backup`) with `cwd: <repoRoot>` and NO `--workdir`/`--project-id`, so
// the CLI resolved the repo `config.toml` and targeted the SHARED dev project `clothing-commerce-api`,
// finishing with `stop --no-backup` — the Phase 2M local data-loss path
// (docs/development/phase-2m-test-isolation.md). They were fail-closed stubs.
//
// This module restores that coverage on the PROVEN ownership boundary in `returns-test-resources.mjs`:
// a unique per-run `rt-<32hex>` project in a disposable temp workdir, started with `--workdir` so every
// CLI call is pinned to the isolated project, fresh-project migrations (NO reset of any existing DB), a
// fail-closed config bind, loopback assertion, env-sanitized child processes, and ownership-verified
// cleanup that can only delete resources positively matched to THIS run's marker. It never calls
// `supabase stop`, never prunes, and never touches the shared dev project.
//
// A runner supplies a declarative spec (fixtures + an `rls` pgTAP target and/or a `vitest` integration
// target); the harness does the isolation. For the one runner that needs a real HTTP server
// (online-commerce) see `bootIsolatedApiServer` below, used by its dedicated runner.
import { spawn, spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, cpSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResources, handleInterrupts } from "./returns-test-resources.mjs";
import {
  assertIsolatedSupabaseArgs,
  assertLoopbackDbHost,
  assertNotSharedProject,
  sanitizedChildEnv,
} from "./supabase-isolation-guard.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SUPABASE = join(ROOT, "node_modules/supabase/dist/supabase.js");
const VITEST = join(ROOT, "node_modules/vitest/vitest.mjs");

// Keeps Kong + PostgREST + GoTrue up (integration suites talk to `${API_URL}/rest/v1/...`).
export const EXCLUDE_KEEP_API =
  "realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
// Pure in-DB pgTAP (`supabase test db`) needs only Postgres — drop the API layer for a faster start.
export const EXCLUDE_DB_ONLY = EXCLUDE_KEEP_API + ",gotrue,kong,postgrest";

export async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function allocatePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

export function verifyPgtapPlan(file, expected) {
  const source = readFileSync(join(ROOT, "supabase/tests", file), "utf8");
  const matches = [...source.matchAll(/\bselect\s+plan\(\s*(\d+)\s*\)\s*;/giu)];
  if (matches.length !== 1)
    throw new Error(
      `${file}: expected exactly one pgTAP plan declaration, found ${matches.length}.`,
    );
  const declared = Number(matches[0][1]);
  if (expected !== undefined && declared !== expected)
    throw new Error(`${file}: expected a ${expected}-assertion pgTAP plan, found ${declared}.`);
  process.stdout.write(`Verified ${file} pgTAP plan: ${declared} assertions.\n`);
}

/**
 * Prepare an isolated, ownership-proven Supabase stack. Returns handles the caller drives. The caller is
 * responsible for calling `cleanup()` in a `finally` (or using `runIsolatedSupabaseSuite`, which does).
 * @param {{ excluded?: string, extraPorts?: number }} [options]
 */
export async function createIsolatedStack(options = {}) {
  const resources = createResources();
  const isolated = resources.workdir;
  const projectId = resources.projectId;
  // Fail closed before any CLI/Docker call if the minted id is not a disposable rt-<hex> project.
  assertNotSharedProject(projectId);
  const dbContainer = "supabase_db_" + projectId;
  const excluded = options.excluded ?? EXCLUDE_KEEP_API;

  const [apiPort, dbPort, ...extra] = await allocatePorts(2 + (options.extraPorts ?? 0));

  mkdirSync(join(isolated, "supabase"));
  cpSync(join(ROOT, "supabase/migrations"), join(isolated, "supabase/migrations"), {
    recursive: true,
  });
  cpSync(join(ROOT, "supabase/tests"), join(isolated, "supabase/tests"), { recursive: true });
  const config = readFileSync(join(ROOT, "supabase/config.toml"), "utf8")
    .replace('project_id = "clothing-commerce-api"', `project_id = "${projectId}"`)
    .replace("port = 54322", `port = ${dbPort}`)
    .replace("[api]", `[api]\nport = ${apiPort}`);
  writeFileSync(join(isolated, "supabase/config.toml"), config);
  // Fails closed if the project_id swap did not take (would otherwise fall back to the shared project).
  resources.bindConfig(config);

  function run(command, args, opts = {}) {
    const r = spawnSync(command, args, {
      cwd: isolated,
      encoding: "utf8",
      windowsHide: true,
      ...opts,
    });
    if (r.status !== 0)
      throw new Error(
        `isolated command failed: ${command} ${args.join(" ")} (${r.status})\n` +
          (opts.redacted ? "[output redacted]" : [r.stdout, r.stderr].filter(Boolean).join("\n")),
      );
    return r;
  }
  // Every Supabase CLI call goes through here so the static isolation guard runs first: a destructive
  // subcommand without the disposable --workdir (or targeting the shared project) throws before spawning.
  function supa(args, opts = {}) {
    assertIsolatedSupabaseArgs(args, { repoRoot: ROOT });
    return run(process.execPath, [SUPABASE, ...args], opts);
  }
  function sql(source) {
    return run(
      "docker",
      [
        "exec",
        "-i",
        dbContainer,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "supabase_admin",
        "-d",
        "postgres",
      ],
      { input: source, stdio: ["pipe", "inherit", "inherit"] },
    );
  }

  resources.assertOwner();
  run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], { stdio: "inherit" });
  process.stdout.write(`Isolated project: ${projectId}\n`);
  // Fresh project start applies the full migration history. Never reset any existing database.
  supa(["start", "--workdir", isolated, "--exclude", excluded], { redacted: true });
  resources.plan(); // verify only this run's resources exist before touching anything

  function applyFixtures(files) {
    for (const file of files ?? []) sql(readFileSync(join(ROOT, "supabase/tests", file), "utf8"));
    if (files?.length) process.stdout.write(`Applied disposable fixtures: ${files.join(", ")}\n`);
  }

  function getStatus() {
    const status = JSON.parse(
      supa(["status", "--workdir", isolated, "--output", "json"], { redacted: true }).stdout,
    );
    const apiUrl = new URL(status.API_URL);
    // Verify the resolved API host is loopback and on this run's allocated port before any write/test.
    assertLoopbackDbHost(apiUrl.hostname, "isolated Supabase API");
    if (apiUrl.port !== String(apiPort))
      throw new Error("Isolated Supabase returned unexpected API routing");
    return status;
  }

  return {
    resources,
    root: ROOT,
    isolated,
    projectId,
    dbContainer,
    ports: { apiPort, dbPort, extra },
    supa,
    sql,
    run,
    applyFixtures,
    getStatus,
    cleanup: () => resources.cleanup(),
  };
}

/**
 * Choose the Supabase service-exclusion set for a spec. RLS-only suites can drop the API layer
 * (pgTAP runs in-DB); anything with a vitest target needs PostgREST/Kong/GoTrue up. Pure; DB-free.
 * @param {{ excluded?: string, rls?: unknown, vitest?: unknown }} spec
 */
export function selectExcluded(spec) {
  return spec.excluded ?? (spec.vitest ? EXCLUDE_KEEP_API : EXCLUDE_DB_ONLY);
}

/**
 * Run a declarative isolated Supabase suite (pgTAP RLS and/or vitest integration) end to end.
 * @param {{
 *   name: string,
 *   excluded?: string,
 *   setupSql?: string[],
 *   extraSql?: string,
 *   rls?: { files: string[], plans?: Array<{ file: string, expected?: number }> },
 *   vitest?: { dir: string, env: (status: any) => Record<string, string | undefined> },
 * }} spec
 */
export async function runIsolatedSupabaseSuite(spec) {
  if (!spec.rls && !spec.vitest)
    throw new Error("runIsolatedSupabaseSuite: spec must declare an rls and/or vitest target");
  // Verify pgTAP plan integrity BEFORE spinning up Docker so a tampered/weakened plan fails fast.
  for (const { file, expected } of spec.rls?.plans ?? []) verifyPgtapPlan(file, expected);

  const stack = await createIsolatedStack({ excluded: selectExcluded(spec) });
  const removeInterruptHandlers = handleInterrupts(() => stack.cleanup());
  try {
    stack.applyFixtures(spec.setupSql);
    if (spec.extraSql) stack.sql(spec.extraSql);

    if (spec.rls) {
      // Pure in-DB pgTAP: the API layer is intentionally excluded, so there is no API_URL to read. The
      // run is already pinned to this disposable rt-<hex> project (bindConfig + --workdir + plan()).
      stack.supa(["test", "db", ...spec.rls.files, "--workdir", stack.isolated, "--local"], {
        stdio: "inherit",
      });
    }
    if (spec.vitest) {
      // getStatus() asserts the resolved API host is loopback and on this run's port before any test write.
      const status = stack.getStatus();
      // Strip any inherited .env / POS_TEST_* / SUPABASE_* / PG* / connection-string vars so the suite
      // can only reach THIS run's disposable database — then set exactly the isolated values it declares.
      stack.run(
        process.execPath,
        [VITEST, "run", spec.vitest.dir, "--testTimeout=60000", "--hookTimeout=60000"],
        { cwd: stack.root, stdio: "inherit", env: sanitizedChildEnv(spec.vitest.env(status)) },
      );
    }
    process.stdout.write(`Isolated suite passed: ${spec.name}\n`);
  } finally {
    removeInterruptHandlers();
    stack.cleanup();
  }
}

/**
 * Boot the real Next.js API server on loopback against an isolated stack, verifying it comes up. Used by
 * the online-commerce runner. Returns the server handle + a killer the caller must invoke in `finally`.
 * The server env is sanitized then set to exactly the isolated values; production auth is not weakened.
 * @param {{ stack: Awaited<ReturnType<typeof createIsolatedStack>>, nextPort: number, env: Record<string,string|undefined>, healthPath?: string }} args
 */
export async function bootIsolatedApiServer({
  stack,
  nextPort,
  env,
  healthPath = "/api/v1/health",
}) {
  const baseUrl = `http://127.0.0.1:${nextPort}`;
  // The server reaches the DB purely through SUPABASE_URL in its (sanitized) env; run it from the
  // isolated workdir with a node_modules junction so no state leaks from the repo root.
  for (const name of [
    "app",
    "src",
    "packages",
    "package.json",
    "tsconfig.json",
    "next-env.d.ts",
    "next.config.ts",
  ])
    cpSync(join(stack.root, name), join(stack.isolated, name), { recursive: true });
  symlinkSync(
    join(stack.root, "node_modules"),
    join(stack.isolated, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const server = spawn(
    process.execPath,
    [
      join(stack.root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(nextPort),
    ],
    {
      cwd: stack.isolated,
      env: sanitizedChildEnv({ NEXT_TELEMETRY_DISABLED: "1", ...env }),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostic = "";
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-40000);
    });
  const killer = () => {
    if (server?.pid && server.exitCode === null) {
      if (process.platform === "win32") {
        const killed = spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        if (killed.status !== 0)
          throw new Error("Could not stop owned Next.js process; cleanup aborted");
      } else process.kill(-server.pid, "SIGTERM");
    }
  };
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (server.exitCode !== null) throw new Error(`API server exited: ${diagnostic}`);
    try {
      if ((await fetch(`${baseUrl}${healthPath}`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`API server did not start: ${diagnostic}`);
  return { server, baseUrl, killer, diagnosticTail: () => diagnostic };
}

export { crypto };
