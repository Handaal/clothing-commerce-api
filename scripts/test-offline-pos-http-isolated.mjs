// Phase 6B — FULL HTTP-SERVER-PATH offline-POS acceptance on an isolated disposable DB.
//
// Unlike `test-offline-pos-isolated.mjs` (which invokes route handlers in-process), this runner boots
// the REAL Next.js API server as a separate loopback process and drives it over HTTP through the packed
// SDK client. It proves the cases the in-process suite could not: real commit-then-lost-response over
// the wire, installment + balance-reducing payment ingestion, non-cash tender semantics, schema-version
// rejection, and (best-effort) concurrent-device stock behaviour.
//
// ISOLATION: reuses the PROVEN Phase 2M ownership boundary (`returns-test-resources.mjs`) exactly like
// the returns integration runner — unique `rt-<32hex>` project, disposable workdir, `--workdir`-pinned
// CLI, fresh-project migrations (NO reset), fail-closed config bind, label-scoped cleanup. It never
// calls `supabase stop`, never prunes, and never touches the shared dev project.
//
// AUTH: the server verifies Clerk RS256 JWTs using CLERK_JWT_KEY (the repo's existing local-test-key
// path, identical to the returns runner). This is standard configuration, NOT a verifier override or a
// production bypass: production sets CLERK_JWT_KEY to the real Clerk key. No production auth is weakened.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, webcrypto as crypto } from "node:crypto";
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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules/supabase/dist/supabase.js");
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const resources = createResources();
const isolated = resources.workdir;
const projectId = resources.projectId;
// Fail closed before any CLI/Docker call if the minted id is not a disposable rt-<hex> project.
assertNotSharedProject(projectId);
const dbContainer = "supabase_db_" + projectId;
// Lowest-resource FAITHFUL backend for the attendance/offline HTTP path: db + gotrue + kong + postgrest.
// Everything heavy and unused by any offline route or the acceptance assertions is excluded (analytics/
// logflare, vector, realtime, storage, studio, imgproxy, mailpit, postgres-meta, edge-runtime, supavisor).
// gotrue is intentionally KEPT: `supabase status` only emits SERVICE_ROLE_KEY/ANON_KEY when auth is in the
// stack, and the test (PostgREST RLS) + server (supabase-js) need those static JWTs. Container memory is not
// the constraint here (~5 GB free on this host); the prior "4th stack" failure was the attendance migration
// failing to apply, not resource exhaustion.
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
while (ports.size < 3) ports.add(await freePort());
const [apiPort, dbPort, nextPort] = [...ports];

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
resources.bindConfig(config); // fails closed if the project_id swap did not take
for (const name of [
  "app",
  "src",
  "packages",
  "package.json",
  "tsconfig.json",
  "next-env.d.ts",
  "next.config.ts",
])
  cpSync(join(root, name), join(isolated, name), { recursive: true });
symlinkSync(
  join(root, "node_modules"),
  join(isolated, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);

// Drop any line that could carry a key / token / connection string, so `redacted` output stays safe to
// print while still surfacing the actual error (e.g. a failing migration) instead of a blind "[redacted]".
function secretFilter(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/(key|secret|token|jwt|password|postgres(ql)?:\/\/|anon|service_role|eyJ)/i.test(line),
    )
    .join("\n");
}
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: isolated,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (r.status !== 0) {
    const raw = [r.stdout, r.stderr].filter(Boolean).join("\n");
    throw new Error(
      `isolated command failed: ${command} ${args.join(" ")} (${r.status})\n` +
        (options.redacted ? secretFilter(raw).slice(-4000) : raw),
    );
  }
  return r;
}
// Every Supabase CLI call goes through here so the static isolation guard runs first.
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

let server;
function cleanup() {
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
  resources.cleanup();
}
const removeInterruptHandlers = handleInterrupts(cleanup);
try {
  resources.assertOwner();
  run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], { stdio: "inherit" });
  process.stdout.write(`Isolated project: ${projectId}; Next API on 127.0.0.1:${nextPort}\n`);
  supa(["start", "--workdir", isolated, "--exclude", excluded], { redacted: true });
  resources.plan();
  for (const name of ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"])
    sql(readFileSync(join(root, "supabase/tests", name), "utf8"));
  // Raise ONLY this isolated run's offline policy headroom for REGISTER so the HTTP tender/installment
  // regression matrix can execute several sales on one grant. This is a per-run fixture tweak on the
  // disposable DB (supabase_admin) — it does not touch the shared seed, the in-process suite's 3/10000
  // boundary assertions, or any production policy. The commercial limit *logic* is unchanged.
  sql(
    "update public.offline_pos_policies set max_pending_offline_sales = 50, " +
      "max_cumulative_exposure_minor = 100000000, max_offline_credit_exposure_minor = 100000000, " +
      "max_sale_amount_minor = 100000000, max_quantity_per_line = 1000 " +
      "where tenant_id = '2a000001-0000-4000-8000-000000000001';",
  );

  const status = JSON.parse(
    supa(["status", "--workdir", isolated, "--output", "json"], { redacted: true }).stdout,
  );
  const supaUrl = new URL(status.API_URL);
  // Verify the resolved DB/API host is loopback and on this run's allocated port before any write.
  assertLoopbackDbHost(supaUrl.hostname, "isolated Supabase API");
  if (supaUrl.port !== String(apiPort))
    throw new Error("Isolated Supabase returned unexpected API routing");

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const baseUrl = `http://127.0.0.1:${nextPort}`;
  const now = Math.floor(Date.now() / 1000);
  const part = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const issueToken = (subject) => {
    const content =
      part({ alg: "RS256", typ: "JWT", kid: "local-acceptance" }) +
      "." +
      part({
        sub: subject,
        sid: "sess_" + subject,
        iss: "https://clerk.local.test",
        azp: baseUrl,
        iat: now,
        nbf: now - 5,
        exp: now + 3600,
      });
    return (
      content + "." + sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")
    );
  };
  // Strip inherited .env / SUPABASE_* / POS_TEST_* / PG* / connection-string vars, then set exactly the
  // isolated server configuration so the real Next.js API can only reach THIS run's disposable database.
  const serverEnv = sanitizedChildEnv({
    SUPABASE_URL: status.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.local.test$").toString("base64")}`,
    CLERK_SECRET_KEY: "sk_test_local_acceptance_only",
    CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    CLERK_AUTHORIZED_PARTIES: baseUrl,
    OFFLINE_PIN_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    NEXT_TELEMETRY_DISABLED: "1",
  });
  server = spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(nextPort),
    ],
    {
      cwd: isolated,
      env: serverEnv,
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
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (server.exitCode !== null) throw new Error(`API server exited: ${diagnostic}`);
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`API server did not start: ${diagnostic}`);
  process.stdout.write(
    "Real Next.js API + isolated Supabase ready; running HTTP acceptance over the SDK.\n",
  );

  // Which HTTP acceptance suite to run against this isolated server (default: the offline-sale/tender/
  // installment matrix). `--dir <path>` selects another suite (e.g. the multi-device suite) on its own
  // fresh isolated server, so suites never share a database or contend for the same location lock.
  const dirFlagIndex = process.argv.indexOf("--dir");
  const testDir =
    dirFlagIndex >= 0 ? process.argv[dirFlagIndex + 1] : "tests/offline-pos-http-integration";
  try {
    run(process.execPath, [vitest, "run", testDir, "--testTimeout=60000", "--hookTimeout=60000"], {
      cwd: root,
      stdio: "inherit",
      env: sanitizedChildEnv({
        POS_TEST_API_BASE_URL: baseUrl,
        POS_TEST_CLERK_TOKEN: issueToken("pos-full"),
        POS_TEST_SUPABASE_URL: status.API_URL,
        POS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
        POS_TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
      }),
    });
  } catch (error) {
    // The vitest run above is a BLOCKING spawnSync, so the server's stdout/stderr 'data' events cannot
    // fire during it. Yield briefly so the queued pipe output (including the route's console.error with
    // the underlying SQL/stack) flushes before we print the tail. Server-generated only — never secrets.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.stderr.write(
      `\n----- API server log tail -----\n${diagnostic}\n----- end server log -----\n`,
    );
    throw error;
  }
  process.stdout.write("Isolated full-HTTP-path offline-POS acceptance passed.\n");
} finally {
  removeInterruptHandlers();
  cleanup();
}
