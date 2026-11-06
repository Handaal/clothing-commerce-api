import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const testFile = join(
  repositoryRoot,
  "supabase",
  "tests",
  "phase_1c_a_foundational_persistence.sql",
);
const containerName = `clothing-commerce-persistence-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-persistence-test-only";

// Connect every client over container-internal TCP, never the default Unix socket. The official
// postgres image runs a temporary socket-only init server before the real server; a socket-based
// readiness probe can pass against that temporary server and the next psql call then hits its
// teardown ("No such file or directory" or "terminating connection due to administrator command").
// The temporary server never serves TCP, so a TCP target is race-free, needs no host PostgreSQL,
// no Unix socket, and no published host port, and is identical on Windows and Linux.
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

function runInvariantTests(cycle) {
  runPsql(readFileSync(testFile, "utf8"), `[cycle ${cycle}] persistence invariants`);
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
    // pg_isready over TCP only reports ready once the real server (not the socket-only init
    // server) accepts connections, which removes the double-start race entirely.
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
  applyMigrations(1);
  runInvariantTests(1);

  runPsql(
    "drop schema if exists customers_ar_private cascade; drop schema if exists settings_private cascade; drop schema if exists reporting_private cascade; drop schema if exists promotions_private cascade; drop schema if exists staff_private cascade; drop schema if exists attendance_private cascade; drop schema if exists suppliers_private cascade; drop schema if exists returns_private cascade; drop schema if exists online_private cascade; drop schema if exists offline_pos_private cascade; drop schema if exists pos_sales_private cascade; drop schema if exists payments_private cascade; drop schema if exists fulfillments_private cascade; drop schema if exists commerce_locks cascade; drop schema if exists orders_private cascade; drop schema if exists inventory_private cascade; drop schema if exists catalog_public cascade; drop schema if exists catalog_private cascade; drop schema if exists commerce_context cascade; drop schema public cascade; create schema public;",
    "[reset] removed private schemas and recreated empty public schema",
  );

  applyMigrations(2);
  runInvariantTests(2);
  process.stdout.write(
    "Complete migrations and Phase 1C-A persistence tests passed twice from an empty schema.\n",
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
