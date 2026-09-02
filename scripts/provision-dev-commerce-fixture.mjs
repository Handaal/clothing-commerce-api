// Development-only canonical commerce fixture for Phase 2F-B Admin Mobile real-runtime acceptance.
//
// It seeds a small, deterministic, representative commerce graph (brand -> branch -> inventory location
// -> products/variants/options/prices -> opening inventory -> one online order -> one partial
// fulfillment) into the EXISTING dev-local tenant so the Admin Mobile Products (and future Inventory /
// Orders / Fulfillment) read slices have real data to render. It COMPLEMENTS
// scripts/provision-dev-identity.mjs and requires the dev-local tenant to already exist.
//
// This command ONLY knows how to target the LOCAL disposable Supabase Postgres container. It refuses to
// run without the explicit COMMERCE_DEV_FIXTURES=1 opt-in AND a positively-identified local target. It
// grants no permission, adds no production database function (the SQL uses an anonymous DO block plus
// the existing sanctioned domain functions), and never seeds during an API request.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseEntrypoint = join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const sqlFile = join(repositoryRoot, "supabase", "dev", "provision-dev-commerce-fixture.sql");
const databaseContainerName = "supabase_db_clothing-commerce-api";

// Hosts that unambiguously identify the local development stack. A non-local API host is a HARD FAIL:
// this tool deliberately has no way to target a remote Supabase project.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export const USAGE = `Usage: COMMERCE_DEV_FIXTURES=1 pnpm dev:provision-commerce-fixture

Seeds a small deterministic commerce graph (brand, branch, inventory location, two products with
variants/options/prices, opening inventory, one online order, one partial fulfillment) into the
existing local dev-local tenant so Admin Mobile can exercise the real Products list and detail runtime.

Required:
  COMMERCE_DEV_FIXTURES=1   Explicit development opt-in (environment variable).

Preconditions:
  - An API-capable local Supabase stack is running with migrations applied (pnpm supabase:reset).
    See docs/development/commerce-fixture.md for the local start command.
  - The dev-local tenant already exists: run \`pnpm dev:provision-identity\` first.
  - This command only targets the local container "${databaseContainerName}"; a non-local target is refused.

Options:
  -h, --help             Show this help.

This fixture is idempotent and grants no permissions; it only seeds domain records for local runtime.`;

class FixtureError extends Error {}

export function parseArgs(argv) {
  const result = { help: false };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else {
      throw new FixtureError(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

// Guard 1: explicit development opt-in.
export function requireOptIn(environment) {
  if (environment.COMMERCE_DEV_FIXTURES !== "1") {
    throw new FixtureError(
      "Refusing to run: set COMMERCE_DEV_FIXTURES=1 to explicitly opt in to local development fixture provisioning.",
    );
  }
}

// Guard 2: positively identify a LOCAL target from `supabase status` output. Non-local => HARD FAIL.
export function assertLocalStatus(status) {
  if (status === null || typeof status !== "object" || typeof status.API_URL !== "string") {
    throw new FixtureError(
      "Could not read the local Supabase API URL; start the API-capable local stack described in docs/development/commerce-fixture.md.",
    );
  }
  let host;
  try {
    host = new URL(status.API_URL).hostname;
  } catch {
    throw new FixtureError(`Local Supabase API URL is not a valid URL: refusing to proceed.`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new FixtureError(
      `Refusing to seed a fixture against non-local Supabase host "${host}". This command only targets the local development stack.`,
    );
  }
  return host;
}

function run(command, args, { redactOutput = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const details = redactOutput
      ? "output was redacted because it may contain local credentials."
      : [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new FixtureError(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "none"}${details ? `\n${details}` : ""}`,
    );
  }
  return result;
}

function readLocalStatus() {
  const result = run(process.execPath, [supabaseEntrypoint, "status", "--output", "json"], {
    redactOutput: true,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new FixtureError("Local Supabase status was not valid JSON; is the local stack running?");
  }
}

// Guard 2 (second, independent lock): the local Postgres container must exist and be running.
function assertLocalContainerRunning() {
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", databaseContainerName],
    { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new FixtureError(
      `Local Supabase container "${databaseContainerName}" is not running. Start the API-capable local stack described in docs/development/commerce-fixture.md.`,
    );
  }
}

function applyFixtureSql() {
  const sql = readFileSync(sqlFile, "utf8");
  const result = run(
    "docker",
    [
      "exec",
      "--interactive",
      databaseContainerName,
      "psql",
      "--no-psqlrc",
      "--quiet",
      "--username",
      "supabase_admin",
      "--dbname",
      "postgres",
      "--file=-",
    ],
    { input: sql },
  );
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
}

export function main(argv, environment) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    requireOptIn(environment);
    assertLocalStatus(readLocalStatus());
    assertLocalContainerRunning();
    process.stdout.write("Provisioning the local development commerce fixture...\n");
    applyFixtureSql();
    process.stdout.write(
      "\nDone. This fixture is development-only and idempotent; it grants no permissions.\n",
    );
    return 0;
  } catch (error) {
    if (error instanceof FixtureError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
