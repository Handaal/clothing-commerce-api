// Development-only Clerk identity provisioning for Phase 2F-B Admin Mobile real-runtime acceptance.
//
// It binds a REAL, externally-created Clerk development subject into the Commerce authorization model
// (active UserIdentity -> active Clerk binding -> active dev tenant -> active Membership -> active Role
// granting exactly catalog.read/inventory.read/orders.read -> tenant-wide AccessScope -> active
// MembershipRoleAssignment) so a genuine Clerk login can call GET /api/v1/me/tenants and /me/context.
//
// This command ONLY knows how to target the LOCAL disposable Supabase Postgres container. It refuses to
// run without the explicit COMMERCE_DEV_PROVISIONING=1 opt-in AND a positively-identified local target.
// It never fabricates the Clerk subject, never embeds Clerk/service-role secrets, never auto-provisions
// during an API request, and adds no production database function (the SQL uses an anonymous DO block).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseEntrypoint = join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const sqlFile = join(repositoryRoot, "supabase", "dev", "provision-dev-identity.sql");
const databaseContainerName = "supabase_db_clothing-commerce-api";

// Hosts that unambiguously identify the local development stack. A non-local API host is a HARD FAIL:
// this tool deliberately has no way to target a remote Supabase project.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export const USAGE = `Usage: pnpm dev:provision-identity -- --clerk-subject <REAL_CLERK_USER_ID>

Binds a real Clerk development subject to the local Commerce authorization model so Admin Mobile can
exercise the real /me/tenants and /me/context runtime flow.

Required:
  --clerk-subject <id>   The Clerk userId (subject) of a Clerk development user you created first.
  COMMERCE_DEV_PROVISIONING=1   Explicit development opt-in (environment variable).

Preconditions:
  - The local Supabase stack is running (pnpm supabase:start) with migrations applied (pnpm supabase:reset).
  - This command only targets the local container "${databaseContainerName}"; a non-local target is refused.

Options:
  -h, --help             Show this help.

Signing into Clerk does NOT by itself grant Commerce access; this command creates the authorization graph.`;

class ProvisioningError extends Error {}

export function parseArgs(argv) {
  const result = { help: false, clerkSubject: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg === "--clerk-subject") {
      result.clerkSubject = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--clerk-subject=")) {
      result.clerkSubject = arg.slice("--clerk-subject=".length);
    } else {
      throw new ProvisioningError(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

// Guard 1: explicit development opt-in.
export function requireOptIn(environment) {
  if (environment.COMMERCE_DEV_PROVISIONING !== "1") {
    throw new ProvisioningError(
      "Refusing to run: set COMMERCE_DEV_PROVISIONING=1 to explicitly opt in to local development provisioning.",
    );
  }
}

// Guard 3 input validation.
export function requireClerkSubject(clerkSubject) {
  if (typeof clerkSubject !== "string" || clerkSubject.trim() === "") {
    throw new ProvisioningError("Missing required --clerk-subject <REAL_CLERK_USER_ID>.");
  }
  return clerkSubject.trim();
}

// Guard 2: positively identify a LOCAL target from `supabase status` output. Non-local => HARD FAIL.
export function assertLocalStatus(status) {
  if (status === null || typeof status !== "object" || typeof status.API_URL !== "string") {
    throw new ProvisioningError(
      "Could not read the local Supabase API URL; is the local stack running (pnpm supabase:start)?",
    );
  }
  let host;
  try {
    host = new URL(status.API_URL).hostname;
  } catch {
    throw new ProvisioningError(`Local Supabase API URL is not a valid URL: refusing to proceed.`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new ProvisioningError(
      `Refusing to provision against non-local Supabase host "${host}". This command only targets the local development stack.`,
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
    throw new ProvisioningError(
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
    throw new ProvisioningError(
      "Local Supabase status was not valid JSON; is the local stack running?",
    );
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
    throw new ProvisioningError(
      `Local Supabase container "${databaseContainerName}" is not running. Start it with pnpm supabase:start.`,
    );
  }
}

function applyProvisioningSql(clerkSubject) {
  const sql = readFileSync(sqlFile, "utf8");
  // The subject is passed as a discrete argv token (never shell-interpolated) and consumed inside the
  // SQL exclusively through psql's :'clerk_subject' safe quoting -> a transaction-local GUC.
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
      "--variable",
      `clerk_subject=${clerkSubject}`,
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
    const clerkSubject = requireClerkSubject(args.clerkSubject);
    assertLocalStatus(readLocalStatus());
    assertLocalContainerRunning();
    process.stdout.write(
      "Provisioning local development identity (subject withheld from output)...\n",
    );
    applyProvisioningSql(clerkSubject);
    process.stdout.write(
      "\nDone. This identity is development-only; Clerk login alone never grants Commerce access.\n",
    );
    return 0;
  } catch (error) {
    if (error instanceof ProvisioningError) {
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
