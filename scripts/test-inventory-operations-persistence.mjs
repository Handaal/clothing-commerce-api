import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 2C inventory operation persistence regression. Against a disposable PostgreSQL instance it
// applies every migration (including the two new Phase 2C functions and the 'issue' operation type),
// then exercises record_opening and record_count_adjustment behaviour, the generic issue path, and
// the hardening/grant metadata. It runs twice from an empty schema to prove the migrations are
// re-appliable from scratch. Connections use container-internal TCP, so no host PostgreSQL, no Unix
// socket, and no published port are needed; the pattern is identical on Windows and Linux.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const testFile = join(repositoryRoot, "supabase", "tests", "phase_2c_inventory_operations.sql");
const expectedAssertionCount = 42;
const containerName = `clothing-commerce-inventory-operations-persistence-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-inventory-operations-persistence-test-only";

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

function runPsql(sql, label) {
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

  process.stdout.write(result.stdout);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function verifyExpectedAssertionCount() {
  const source = readFileSync(testFile, "utf8");
  const assertions =
    source.match(/select\s+pg_temp\.assert_(?:true|raises|deferred_raises)\s*\(/giu) ?? [];

  if (assertions.length !== expectedAssertionCount) {
    throw new Error(
      `Expected ${expectedAssertionCount} inventory operation persistence assertions, found ${assertions.length}.`,
    );
  }

  process.stdout.write(
    `Verified expected inventory operation persistence count: ${expectedAssertionCount}.\n`,
  );
}

function applyMigrations(cycle) {
  const migrations = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (migrations.length === 0) {
    throw new Error("No SQL migrations were found.");
  }

  for (const migration of migrations) {
    runPsql(
      readFileSync(join(migrationDirectory, migration), "utf8"),
      `[cycle ${cycle}] ${migration}`,
    );
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

verifyExpectedAssertionCount();
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

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    applyMigrations(cycle);
    runPsql(
      readFileSync(testFile, "utf8"),
      `[cycle ${cycle}] inventory operation persistence invariants`,
    );

    if (cycle === 1) {
      runPsql(
        [
          "drop schema if exists orders_private cascade;",
          "drop schema if exists inventory_private cascade;",
          "drop schema if exists catalog_private cascade;",
          "drop schema if exists commerce_context cascade;",
          "drop schema public cascade;",
          "create schema public;",
        ].join("\n"),
        "[reset] removed private schemas and recreated empty public schema",
      );
    }
  }

  process.stdout.write(
    "Complete migrations and Phase 2C inventory operation persistence tests passed twice from an empty schema.\n",
  );
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
