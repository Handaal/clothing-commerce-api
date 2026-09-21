import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, cpSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResources, handleInterrupts } from "./returns-test-resources.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules/supabase/dist/supabase.js");
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
  run(process.execPath, [supabase, "start", "--workdir", isolated, "--exclude", excluded], {
    redacted: true,
    cwd: isolated,
  });
  // Fresh project start applies migrations. Never reset any existing database.
  resources.plan();
  run(
    process.execPath,
    [
      supabase,
      "--workdir",
      isolated,
      "test",
      "db",
      "supabase/tests/phase_2m_returns_rls.test.sql",
      ...(process.argv.includes("--suppliers")
        ? [
            "supabase/tests/phase_2n_suppliers_rls.test.sql",
            "supabase/tests/phase_2c_inventory_operations_rls.test.sql",
          ]
        : []),
      "supabase/tests/phase_1c_b_tenant_rls.test.sql",
      "supabase/tests/phase_2a_catalog_rls.test.sql",
      "supabase/tests/phase_2b_inventory_rls.test.sql",
      "supabase/tests/phase_2d_orders_rls.test.sql",
      "supabase/tests/phase_2e_fulfillment_rls.test.sql",
      "supabase/tests/phase_2l_online_rls.test.sql",
      "--local",
    ],
    { cwd: isolated, stdio: "inherit" },
  );
  if (process.argv.includes("--rls-only")) {
    process.stdout.write("Returns and shared RLS suites passed.\n");
  } else {
    for (const file of [
      "phase_2h_pos_sale.setup.sql",
      "phase_2l_online.setup.sql",
      "phase_2m_returns.setup.sql",
      ...(process.argv.includes("--suppliers") ? ["phase_2n_suppliers.setup.sql"] : []),
    ])
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
    const payload = `${part({ alg: "RS256", typ: "JWT", kid: "local-acceptance" })}.${part({ sub: "pos-full", sid: "sess_local_acceptance", iss: "https://clerk.local.test", azp: baseUrl, iat: now, nbf: now - 5, exp: now + 3600 })}`;
    const token = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
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
    const env = {
      ...process.env,
      SUPABASE_URL: local.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
      CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.local.test$").toString("base64")}`,
      CLERK_SECRET_KEY: "sk_test_local_acceptance_only",
      CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
      CLERK_AUTHORIZED_PARTIES: baseUrl,
      RETURNS_TEST_URL: baseUrl,
      RETURNS_TEST_CONTAINER: dbContainer,
      RETURNS_TEST_TOKEN: token,
      RETURNS_TEST_DENIED_TOKEN: issueToken("pos-no-payment"),
      RETURNS_TEST_SCOPED_TOKEN: issueToken("pos-wrong-branch"),
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
    run(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "tests/returns-integration",
        ...(process.argv.includes("--suppliers")
          ? ["tests/suppliers-integration", "--fileParallelism=false"]
          : []),
        "--testTimeout=60000",
        "--hookTimeout=60000",
      ],
      { cwd: root, env, stdio: "inherit" },
    );
    process.stdout.write(
      "Returns/refunds database, RLS, concurrency and real API acceptance passed.\n",
    );
  }
} finally {
  removeInterruptHandlers();
  cleanup();
}
