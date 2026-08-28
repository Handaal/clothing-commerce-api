import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseEntrypoint = join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const vitestEntrypoint = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const fixtureFile = join(repositoryRoot, "supabase", "tests", "phase_2e_fulfillment.setup.sql");
const databaseContainerName = "supabase_db_clothing-commerce-api";
// PostgREST (postgrest + kong) must stay up: the fulfillment repository calls the sanctioned functions
// in the exposed fulfillments_private schema through the service-role client.
const excludedServices = [
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

function commandFailure(command, args, result) {
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return new Error(
    `${command} ${args.join(" ")} failed with exit code ${result.status ?? "none"}${details ? `\n${details}` : ""}`,
  );
}

function run(command, args, { redactOutput = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    if (redactOutput) {
      throw new Error(
        `${command} ${args.join(" ")} failed with exit code ${result.status ?? "none"}; output was redacted because it may contain local credentials.`,
      );
    }
    throw commandFailure(command, args, result);
  }
  return result;
}

function runSupabase(args, options) {
  return run(process.execPath, [supabaseEntrypoint, ...args], options);
}

function applyFixture() {
  const fixture = readFileSync(fixtureFile, "utf8");
  const result = run(
    "docker",
    [
      "exec",
      "--interactive",
      databaseContainerName,
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
    { input: fixture },
  );
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.stdout.write("Applied disposable Phase 2E fulfillment fixtures.\n");
}

function readLocalCredentials() {
  const result = runSupabase(["status", "--output", "json"], { redactOutput: true });
  const status = JSON.parse(result.stdout);
  if (typeof status.API_URL !== "string" || typeof status.SERVICE_ROLE_KEY !== "string") {
    throw new Error("Local Supabase status did not provide the API URL and service-role key.");
  }
  return { url: status.API_URL, serviceRoleKey: status.SERVICE_ROLE_KEY };
}

run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], { stdio: "inherit" });
runSupabase(["--version"], { stdio: "inherit" });

let startAttempted = false;

try {
  startAttempted = true;
  runSupabase(["start", "--exclude", excludedServices.join(",")], { redactOutput: true });
  process.stdout.write("Started the disposable local Supabase API stack.\n");
  runSupabase(["db", "reset", "--local", "--no-seed"], { stdio: "inherit" });
  applyFixture();

  const credentials = readLocalCredentials();
  run(process.execPath, [vitestEntrypoint, "run", "tests/fulfillments-integration"], {
    env: {
      ...process.env,
      FULFILLMENT_TEST_SUPABASE_URL: credentials.url,
      FULFILLMENT_TEST_SUPABASE_SERVICE_ROLE_KEY: credentials.serviceRoleKey,
    },
    stdio: "inherit",
  });
  process.stdout.write("Phase 2E fulfillment integration tests passed from a reset database.\n");
} finally {
  if (startAttempted) {
    const cleanup = spawnSync(process.execPath, [supabaseEntrypoint, "stop", "--no-backup"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (cleanup.status !== 0) {
      process.stderr.write("Failed to stop the local Supabase stack and remove its test data.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("Stopped the local Supabase stack and removed its disposable data.\n");
    }
  }
}
