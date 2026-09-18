import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules/supabase/dist/supabase.js");
const excluded =
  "realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
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
      "supabase_db_clothing-commerce-api",
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
let started = false;
try {
  started = true;
  run(process.execPath, [supabase, "start", "--exclude", excluded], { redacted: true });
  run(process.execPath, [supabase, "db", "reset", "--local", "--no-seed"], { stdio: "inherit" });
  for (const file of ["phase_2h_pos_sale.setup.sql", "phase_2l_online.setup.sql"])
    sql(readFileSync(join(root, "supabase/tests", file), "utf8"));
  const local = JSON.parse(
    run(process.execPath, [supabase, "status", "--output", "json"], { redacted: true }).stdout,
  );
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const baseUrl = "http://127.0.0.1:3139";
  const now = Math.floor(Date.now() / 1000);
  const part = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const payload = `${part({ alg: "RS256", typ: "JWT", kid: "local-acceptance" })}.${part({ sub: "pos-full", sid: "sess_local_acceptance", iss: "https://clerk.local.test", azp: baseUrl, iat: now, nbf: now - 5, exp: now + 3600 })}`;
  const token = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
  const env = {
    ...process.env,
    SUPABASE_URL: local.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.local.test$").toString("base64")}`,
    CLERK_SECRET_KEY: "sk_test_local_acceptance_only",
    CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    CLERK_AUTHORIZED_PARTIES: baseUrl,
    ONLINE_TEST_URL: baseUrl,
    ONLINE_TEST_TOKEN: token,
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
      "3139",
    ],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
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
    [join(root, "node_modules/vitest/vitest.mjs"), "run", "tests/online-commerce-integration"],
    { env, stdio: "inherit" },
  );
  process.stdout.write(
    "Online commerce database, RLS, concurrency and real API acceptance passed.\n",
  );
} finally {
  if (server?.pid) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else server.kill("SIGTERM");
  }
  if (started) run(process.execPath, [supabase, "stop", "--no-backup"], { redacted: true });
}
