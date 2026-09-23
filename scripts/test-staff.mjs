import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, cpSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResources, handleInterrupts } from "./returns-test-resources.mjs";

// Phase 2O Admin-Mobile staff runtime orchestration. Boots a DISPOSABLE, ownership-validated Supabase +
// the REAL Next.js API with a locally-signed Clerk-verifiable session, provisions the staff fixture graph
// (base tenant-wide staff.manage admin, linkable identities, a shared-email duplicate pair, subset /
// escalated / archived / permissionless / foreign roles and scopes from the canonical assignment
// catalogs, plus a second admin-eligible identity for the two-admin last-admin proof), then drives the
// REAL Admin-Mobile UI (acceptance/staff.runtime.tsx, scenarios A–N incl. Admin-side H foreign-scope
// isolation and J last-admin single/two-admin) against it over real HTTP. It NEVER targets production or normal developer data — the disposable project is
// cryptographically fresh and torn down at the end. Mirrors scripts/test-returns.mjs exactly for the
// stack lifecycle; only the fixtures, env and the suite it runs differ.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules/supabase/dist/supabase.js");
// The Admin-Mobile app under test is a sibling checkout; override with ADMIN_MOBILE_DIR if elsewhere.
const adminMobile =
  process.env.ADMIN_MOBILE_DIR ?? join(dirname(root), "clothing-commerce-admin-mobile");
if (!existsSync(join(adminMobile, "acceptance/staff.runtime.tsx")))
  throw new Error(
    `Admin-Mobile checkout not found at ${adminMobile}; set ADMIN_MOBILE_DIR to its path.`,
  );
if (!existsSync(join(adminMobile, "node_modules/vitest/vitest.mjs")))
  throw new Error(
    `Admin-Mobile dependencies are not installed; run pnpm install in ${adminMobile}.`,
  );

const resources = createResources();
const isolated = resources.workdir;
const projectId = resources.projectId;
const dbContainer = "supabase_db_" + projectId;
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
  .replace('project_id = "clothing-commerce-api"', 'project_id = "' + projectId + '"')
  .replace("port = 54322", `port = ${dbPort}`)
  .replace("[api]", `[api]\nport = ${apiPort}`);
writeFileSync(join(isolated, "supabase/config.toml"), config);
resources.bindConfig(config);
for (const name of [
  "app",
  "src",
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
const excluded =
  "realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: isolated,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (r.status !== 0)
    throw new Error(
      `Local acceptance command failed: ${command} ${args.join(" ")}\n${options.redacted ? "Output redacted" : `${r.stdout ?? ""}\n${r.stderr ?? ""}`}`,
    );
  return r;
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
    { input: source },
  );
}
let server;
function cleanup() {
  // The disposable Supabase teardown MUST run even if stopping the owned Next.js process fails, so a
  // benign kill failure never leaks Docker containers/volumes. Stop the owned process tree first (best
  // effort — a non-zero taskkill status when the tree has already exited is benign and not fatal), then
  // always tear down the isolated stack.
  try {
    if (server?.pid && server.exitCode === null) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else process.kill(-server.pid, "SIGTERM");
    }
  } finally {
    resources.cleanup();
  }
}
const removeInterruptHandlers = handleInterrupts(cleanup);
try {
  resources.assertOwner();
  run(process.execPath, [supabase, "start", "--workdir", isolated, "--exclude", excluded], {
    redacted: true,
    cwd: isolated,
  });
  // Fresh project start applies migrations. Never reset any existing database.
  resources.plan();
  // Database RLS proof for the staff surface plus the shared tenant boundary it depends on.
  run(
    process.execPath,
    [
      supabase,
      "--workdir",
      isolated,
      "test",
      "db",
      "supabase/tests/phase_2o_staff_rls.test.sql",
      "supabase/tests/phase_1c_b_tenant_rls.test.sql",
      "--local",
    ],
    { cwd: isolated, stdio: "inherit" },
  );
  // Fixture graph: the shared base actor (tenant-wide admin, roles/scopes) then the staff-specific
  // linkable identities, duplicate-email pair, and catalog role/scope fixtures.
  for (const file of ["phase_2h_pos_sale.setup.sql", "phase_2o_staff.setup.sql"])
    sql(readFileSync(join(root, "supabase/tests", file), "utf8"));

  const local = JSON.parse(
    run(process.execPath, [supabase, "status", "--workdir", isolated, "--output", "json"], {
      redacted: true,
    }).stdout,
  );
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const baseUrl = `http://127.0.0.1:${nextPort}`;
  const apiUrl = new URL(local.API_URL);
  if (!["127.0.0.1", "localhost"].includes(apiUrl.hostname) || apiUrl.port !== String(apiPort))
    throw new Error("Isolated Supabase returned unexpected API routing");
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
  // The base staff actor (membership 2a…12-01, identity 2a…10-01) is bound to clerk subject "pos-full"
  // and is the tenant-wide staff.manage administrator seeded by phase_2o_staff.setup.sql.
  const env = {
    ...process.env,
    SUPABASE_URL: local.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.local.test$").toString("base64")}`,
    CLERK_SECRET_KEY: "sk_test_local_acceptance_only",
    CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    CLERK_AUTHORIZED_PARTIES: baseUrl,
    STAFF_TEST_URL: baseUrl,
    STAFF_TEST_CONTAINER: dbContainer,
    STAFF_TEST_TENANT_ID: "2a000001-0000-4000-8000-000000000001",
    STAFF_TEST_TOKEN: issueToken("pos-full"),
    // A second, independent admin-eligible session (identity 2a…10-05, binding subject "staff-admin-2").
    // It has NO membership until scenario J provisions its tenant-wide admin membership at runtime; once
    // provisioned this session can authoritatively re-read staff state to prove the two-admin removal
    // succeeded and it remains the effective administrator, WITHOUT relying on the (now powerless) base
    // actor session that just removed its own last-admin authority.
    STAFF_TEST_SECOND_ADMIN_TOKEN: issueToken("staff-admin-2"),
    STAFF_TEST_ELIGIBLE_EMAIL: "dana@example.test",
    STAFF_TEST_DUP_EMAIL: "shared@example.test",
    STAFF_TEST_PARTIAL_EMAIL: "percy@example.test",
    EXPO_PUBLIC_COMMERCE_API_URL: baseUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  };
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
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Do not echo runtime environment or credentials. Capture a bounded diagnostic tail.
  let diagnostic = "";
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8000);
    });
  let ready = false;
  for (let n = 0; n < 90; n++) {
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
    "Real Next.js API and local Supabase ready; using locally signed Clerk-verifiable test session.\n",
  );
  // Drive the REAL Admin-Mobile staff UI (scenarios A–N, incl. Admin-side H and J) over real HTTP.
  run(
    process.execPath,
    [
      join(adminMobile, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.runtime.config.mts",
      "acceptance/staff.runtime.tsx",
    ],
    { cwd: adminMobile, env, stdio: "inherit" },
  );
  process.stdout.write("Staff database RLS and real Admin-Mobile UI runtime acceptance passed.\n");
} finally {
  removeInterruptHandlers();
  cleanup();
}
