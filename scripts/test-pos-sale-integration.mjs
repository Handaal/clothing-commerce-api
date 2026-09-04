import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules", "supabase", "dist", "supabase.js");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const fixture = join(root, "supabase", "tests", "phase_2h_pos_sale.setup.sql");
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
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${output}`);
  }
  return result;
}

let started = false;
try {
  run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], { stdio: "inherit" });
  started = true;
  run(process.execPath, [supabase, "start", "--exclude", excluded.join(",")]);
  run(process.execPath, [supabase, "db", "reset", "--local", "--no-seed"], { stdio: "inherit" });
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
    { input: readFileSync(fixture, "utf8"), stdio: ["pipe", "inherit", "inherit"] },
  );
  const status = JSON.parse(run(process.execPath, [supabase, "status", "--output", "json"]).stdout);
  run(process.execPath, [vitest, "run", "tests/pos-sale-integration"], {
    env: {
      ...process.env,
      POS_TEST_SUPABASE_URL: status.API_URL,
      POS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    },
    stdio: "inherit",
  });
} finally {
  if (started) {
    const cleanup = spawnSync(process.execPath, [supabase, "stop", "--no-backup"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (cleanup.status !== 0) process.exitCode = 1;
  }
}
