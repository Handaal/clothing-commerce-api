import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules", "supabase", "dist", "supabase.js");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const container = "supabase_db_clothing-commerce-api";
const excluded = [
  "realtime",
  "storage-api",
  "imgproxy",
  "mailpit",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  return result;
}

async function waitForFixtureSchema(status) {
  let lastFailure = "no response";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${status.API_URL}/rest/v1/rpc/phase_2i_test_set_price`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          apikey: status.SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ p_amount: 2500 }),
      });
      if (response.ok) return;
      lastFailure = `${response.status}: ${await response.text()}`;
    } catch (error) {
      // PostgREST can briefly refuse connections while reloading its schema cache.
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `PostgREST did not expose the Phase 2I integration fixture RPCs in time (${lastFailure}).`,
  );
}
let started = false;
try {
  run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], { stdio: "inherit" });
  started = true;
  run(process.execPath, [supabase, "start", "--exclude", excluded.join(",")]);
  run(process.execPath, [supabase, "db", "reset", "--local", "--no-seed"], { stdio: "inherit" });
  for (const name of ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"]) {
    run(
      "docker",
      [
        "exec",
        "--interactive",
        container,
        "psql",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--username",
        "supabase_admin",
        "--dbname",
        "postgres",
        "--file=-",
      ],
      {
        input: readFileSync(join(root, "supabase", "tests", name), "utf8"),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
  const status = JSON.parse(run(process.execPath, [supabase, "status", "--output", "json"]).stdout);
  await waitForFixtureSchema(status);
  run(process.execPath, [vitest, "run", "tests/offline-pos-integration"], {
    env: {
      ...process.env,
      POS_TEST_SUPABASE_URL: status.API_URL,
      POS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      POS_TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
    },
    stdio: "inherit",
  });
} finally {
  if (started) {
    const result = spawnSync(process.execPath, [supabase, "stop", "--no-backup"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) process.exitCode = 1;
  }
}
