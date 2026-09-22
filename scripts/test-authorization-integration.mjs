import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseEntrypoint = join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const vitestEntrypoint = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const fixtureFile = join(
  repositoryRoot,
  "supabase",
  "tests",
  "phase_1d_authorization_repository.setup.sql",
);
const databaseContainerName = "supabase_db_clothing-commerce-api";
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

// Replace secret and secret-shaped values before anything is logged. The goal is a diagnostic that keeps
// the useful non-secret signal (failing stage, exit code, PostgreSQL/config error text, migration/file
// names) while never emitting JWTs, anon/service keys, database passwords, or credential-bearing URLs.
function sanitize(text) {
  if (!text) return "";
  return (
    text
      // Credentials embedded in URLs: scheme://user:password@host -> scheme://user:REDACTED@host
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, "$1REDACTED@")
      // JWTs (header.payload.signature; header begins eyJ)
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "REDACTED.JWT")
      // Supabase publishable/secret API keys
      .replace(/sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, "REDACTED_SB_KEY")
      // Known secret-named JSON/TOML fields: "FIELD":"value" or FIELD = "value"
      .replace(
        /("?(?:ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|SECRET_KEY|PUBLISHABLE_KEY|DB_URL|password|token|api[_-]?key)"?\s*[:=]\s*")[^"]*(")/gi,
        "$1REDACTED$2",
      )
  );
}

// Best-effort, secret-free container status snapshot to accompany a Supabase startup failure. Names and
// statuses carry no credentials; failure here never masks the primary error.
function supabaseContainerStatus() {
  const result = spawnSync(
    "docker",
    ["ps", "-a", "--filter", "name=supabase", "--format", "{{.Names}}\t{{.Status}}"],
    { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
  );
  const output = (result.stdout ?? "").trim();
  return output === "" ? "(no supabase containers found)" : output;
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
      const diagnostic = sanitize([result.stdout, result.stderr].filter(Boolean).join("\n"));
      throw new Error(
        `${command} ${args.join(" ")} failed with exit code ${result.status ?? "none"}.\n` +
          `Output is sanitized (JWTs, anon/service keys, DB passwords, and credential URLs are masked) ` +
          `rather than fully redacted, so the underlying failure remains diagnosable:\n` +
          `${diagnostic || "(no output captured)"}\n` +
          `--- supabase container status ---\n${supabaseContainerStatus()}`,
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
  process.stdout.write("Applied disposable Phase 1D authorization repository fixtures.\n");
}

function readLocalCredentials() {
  const result = runSupabase(["status", "--output", "json"], { redactOutput: true });
  const status = JSON.parse(result.stdout);
  if (typeof status.API_URL !== "string" || typeof status.SERVICE_ROLE_KEY !== "string") {
    throw new Error("Local Supabase status did not provide the API URL and service-role key.");
  }
  return { url: status.API_URL, serviceRoleKey: status.SERVICE_ROLE_KEY };
}

run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], {
  stdio: "inherit",
});
runSupabase(["--version"], { stdio: "inherit" });

let startAttempted = false;

try {
  startAttempted = true;
  runSupabase(["start", "--exclude", excludedServices.join(",")], { redactOutput: true });
  process.stdout.write("Started the disposable local Supabase API stack.\n");
  runSupabase(["db", "reset", "--local", "--no-seed"], { stdio: "inherit" });
  applyFixture();

  const credentials = readLocalCredentials();
  run(process.execPath, [vitestEntrypoint, "run", "tests/authorization-integration"], {
    env: {
      ...process.env,
      AUTHORIZATION_TEST_SUPABASE_URL: credentials.url,
      AUTHORIZATION_TEST_SUPABASE_SERVICE_ROLE_KEY: credentials.serviceRoleKey,
    },
    stdio: "inherit",
  });
  process.stdout.write(
    "Phase 1D authorization repository integration tests passed from a reset database.\n",
  );
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
