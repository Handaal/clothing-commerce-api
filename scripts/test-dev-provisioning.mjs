import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Disposable-local integration runner for the development identity provisioning workflow. It starts and
// resets the local Supabase stack, then exercises scripts/provision-dev-identity.mjs against real
// Postgres (never a shared or production project) and asserts the provisioned authorization graph.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseEntrypoint = join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const vitestEntrypoint = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
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

  const credentials = readLocalCredentials();
  run(process.execPath, [vitestEntrypoint, "run", "tests/dev-provisioning-integration"], {
    env: {
      ...process.env,
      DEV_PROVISIONING_TEST_SUPABASE_URL: credentials.url,
      DEV_PROVISIONING_TEST_SUPABASE_SERVICE_ROLE_KEY: credentials.serviceRoleKey,
    },
    stdio: "inherit",
  });
  process.stdout.write("Development identity provisioning integration tests passed.\n");
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
