// Phase 6 (offline-first roadmap) isolated real-API acceptance for the offline POS surface.
//
// WHY THIS EXISTS: the stock `test:pos:offline:integration` / `test:pos:offline:rls` runners target
// the SHARED development Supabase project `clothing-commerce-api` (hardcoded container name, no
// `--workdir`/`--project-id`) and finish with `supabase stop --no-backup`. That is the exact
// destructive path that caused the Phase 2M local data-loss incident
// (docs/development/phase-2m-test-isolation.md). They must never be run against the shared project.
//
// This runner instead reuses the PROVEN ownership boundary in `returns-test-resources.mjs`: a unique
// per-run `rt-<32hex>` project in a disposable temp workdir, started with `--workdir` so every CLI
// call is pinned to the isolated project, fresh-project migrations (NO reset of any existing DB), and
// ownership-verified cleanup that can only delete resources positively matched to THIS run's marker.
// It never calls `supabase stop`, never prunes, and never touches the shared dev project.
//
// It runs the real offline-pos pgTAP RLS plan and the real `tests/offline-pos-integration` suite
// (real route handlers + real Supabase RPC ingestion) against the disposable database. Only the
// external Clerk identity is faked (as the in-repo test already does); the DB, RPCs, RLS,
// idempotency/replay, reconciliation and inventory are all real.
import { spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules/supabase/dist/supabase.js");
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const resources = createResources();
const isolated = resources.workdir;
const projectId = resources.projectId;
// Fail closed before any CLI/Docker call if the minted id is not a disposable rt-<hex> project.
assertNotSharedProject(projectId);
const dbContainer = "supabase_db_" + projectId;

// Keep the exposed-service set identical to the stock integration runner so Kong + PostgREST + GoTrue
// are available (the integration test talks to `${API_URL}/rest/v1/...`).
const excluded =
  "realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const ports = new Set();
while (ports.size < 2) ports.add(await freePort());
const [apiPort, dbPort] = [...ports];

mkdirSync(join(isolated, "supabase"));
cpSync(join(root, "supabase/migrations"), join(isolated, "supabase/migrations"), {
  recursive: true,
});
cpSync(join(root, "supabase/tests"), join(isolated, "supabase/tests"), { recursive: true });
const config = readFileSync(join(root, "supabase/config.toml"), "utf8")
  .replace('project_id = "clothing-commerce-api"', `project_id = "${projectId}"`)
  .replace("port = 54322", `port = ${dbPort}`)
  .replace("[api]", `[api]\nport = ${apiPort}`);
writeFileSync(join(isolated, "supabase/config.toml"), config);
// Fails closed if the project_id swap did not take (would otherwise fall back to the shared project).
resources.bindConfig(config);

function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: isolated,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (r.status !== 0)
    throw new Error(
      `isolated command failed: ${command} ${args.join(" ")} (${r.status})\n` +
        (options.redacted ? "[output redacted]" : [r.stdout, r.stderr].filter(Boolean).join("\n")),
    );
  return r;
}
// Every Supabase CLI call goes through here so the static isolation guard runs first: a destructive
// subcommand without the disposable --workdir (or targeting the shared project) throws before spawning.
function supa(args, options = {}) {
  assertIsolatedSupabaseArgs(args, { repoRoot: root });
  return run(process.execPath, [supabase, ...args], options);
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
async function waitForFixtureSchema(apiUrl, serviceRoleKey) {
  let lastFailure = "no response";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/rest/v1/rpc/phase_2i_test_set_price`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
        },
        body: JSON.stringify({ p_amount: 2500 }),
      });
      if (response.ok) return;
      lastFailure = `${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PostgREST did not expose the Phase 2I fixture RPCs in time (${lastFailure}).`);
}

const removeInterruptHandlers = handleInterrupts(() => resources.cleanup());
try {
  resources.assertOwner();
  run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], { stdio: "inherit" });
  process.stdout.write(`Isolated project: ${projectId}\n`);
  // Fresh project start applies the full migration history. Never reset any existing database.
  supa(["start", "--workdir", isolated, "--exclude", excluded], { redacted: true });
  resources.plan(); // verify only this run's resources exist before touching anything

  for (const name of ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"])
    sql(readFileSync(join(root, "supabase/tests", name), "utf8"));

  const status = JSON.parse(
    supa(["status", "--workdir", isolated, "--output", "json"], { redacted: true }).stdout,
  );
  const apiUrl = new URL(status.API_URL);
  // Verify the resolved DB/API host is loopback and on this run's allocated port before any write.
  assertLoopbackDbHost(apiUrl.hostname, "isolated Supabase API");
  if (apiUrl.port !== String(apiPort))
    throw new Error("Isolated Supabase returned unexpected API routing");
  await waitForFixtureSchema(status.API_URL, status.SERVICE_ROLE_KEY);

  // --rls-only runs just the pgTAP plan; --skip-rls runs just the integration suite; default runs both.
  const rlsOnly = process.argv.includes("--rls-only");
  const skipRls = process.argv.includes("--skip-rls");

  if (!skipRls) {
    // Real offline-pos RLS pgTAP plan against the isolated database.
    supa(
      [
        "test",
        "db",
        "supabase/tests/phase_2i_offline_pos_rls.test.sql",
        "--workdir",
        isolated,
        "--local",
      ],
      { stdio: "inherit" },
    );
  }

  if (!rlsOnly) {
    // Real offline-pos integration suite (route handlers + Supabase RPC ingestion) against the isolated DB.
    run(
      process.execPath,
      [
        vitest,
        "run",
        "tests/offline-pos-integration",
        "--testTimeout=60000",
        "--hookTimeout=60000",
      ],
      {
        cwd: root,
        stdio: "inherit",
        // Strip any inherited .env / POS_TEST_* / SUPABASE_* / PG* / connection-string vars so the suite
        // can only reach THIS run's disposable database — then set exactly the isolated values.
        env: sanitizedChildEnv({
          POS_TEST_SUPABASE_URL: status.API_URL,
          POS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
          POS_TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
          POS_TEST_OFFLINE_PIN_KEK: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("base64"),
        }),
      },
    );
  }
  process.stdout.write("Isolated offline-POS acceptance passed.\n");
} finally {
  removeInterruptHandlers();
  resources.cleanup();
}
