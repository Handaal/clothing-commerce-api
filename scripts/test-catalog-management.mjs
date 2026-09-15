import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 2J catalog-management acceptance harness. It boots a throwaway PostgreSQL, applies every
// migration in order, and runs the Phase 2J acceptance script, which exercises the sanctioned catalog
// write functions and the public read boundary while switching database roles to prove authorization
// and tenant isolation. The acceptance script self-asserts and aborts psql on any failure; this harness
// additionally requires the terminal success marker so a silent regression cannot pass.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const testFile = join(repositoryRoot, "supabase", "tests", "phase_2j_catalog_management.sql");
const successMarker = "ALL_CATALOG_ACCEPTANCE_ASSERTIONS_PASSED";
const containerName = `clothing-commerce-catalog-management-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-catalog-management-test-only";

const pgHost = "127.0.0.1";
const pgPort = "5432";
const psqlConnectionArgs = [
  "--host",
  pgHost,
  "--port",
  pgPort,
  "--username",
  "postgres",
  "--dbname",
  databaseName,
];

function runDocker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    windowsHide: true,
  });

  if (!allowFailure && result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`docker ${args.join(" ")} failed\n${details}`);
  }

  return result;
}

function runPsql(sql, label, { capture = false } = {}) {
  process.stdout.write(`${label}\n`);

  const result = runDocker(
    [
      "exec",
      "--interactive",
      "--env",
      `PGPASSWORD=${databasePassword}`,
      containerName,
      "psql",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      ...psqlConnectionArgs,
      "--file=-",
    ],
    { input: sql },
  );

  if (!capture) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result;
}

function applyMigrations() {
  const migrations = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (migrations.length === 0) {
    throw new Error("No SQL migrations were found.");
  }

  for (const migration of migrations) {
    runPsql(readFileSync(join(migrationDirectory, migration), "utf8"), `[migrate] ${migration}`);
  }
}

function createSupabaseRoleFixtures() {
  runPsql(
    [
      "create role anon nologin noinherit;",
      "create role authenticated nologin noinherit;",
      "create role service_role nologin noinherit bypassrls;",
    ].join("\n"),
    "[setup] created local Supabase role fixtures",
  );
}

function waitForPostgres() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = runDocker(
      [
        "exec",
        containerName,
        "pg_isready",
        "--host",
        pgHost,
        "--port",
        pgPort,
        "--username",
        "postgres",
        "--dbname",
        databaseName,
      ],
      { allowFailure: true },
    );

    if (result.status === 0) {
      return;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  throw new Error("PostgreSQL did not become ready within 60 seconds.");
}

const dockerVersion = runDocker(["version", "--format", "{{.Server.Version}}"]).stdout.trim();
process.stdout.write(`Docker engine ${dockerVersion}\n`);

let containerStarted = false;

try {
  const start = runDocker([
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--env",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "--env",
    `POSTGRES_DB=${databaseName}`,
    postgresImage,
  ]);
  containerStarted = true;
  process.stdout.write(`Started PostgreSQL container ${start.stdout.trim()}\n`);

  waitForPostgres();
  createSupabaseRoleFixtures();
  applyMigrations();

  const result = runPsql(
    readFileSync(testFile, "utf8"),
    "[acceptance] Phase 2J catalog management + publication",
    { capture: true },
  );

  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(successMarker)) {
    throw new Error(`Catalog management acceptance did not reach ${successMarker}.\n${output}`);
  }

  process.stdout.write(`${successMarker}\nPhase 2J catalog management acceptance passed.\n`);
} finally {
  if (containerStarted) {
    const cleanup = runDocker(["rm", "--force", containerName], { allowFailure: true });

    if (cleanup.status !== 0) {
      const details = [cleanup.stdout, cleanup.stderr].filter(Boolean).join("\n");
      process.stderr.write(`Failed to remove PostgreSQL container ${containerName}\n${details}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Removed PostgreSQL container ${containerName}\n`);
    }
  }
}
