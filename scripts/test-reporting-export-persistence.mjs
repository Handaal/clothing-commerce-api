import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 2Q-C reporting CSV EXPORT persistence regression. Against a disposable PostgreSQL instance it
// applies every migration (including the reporting_reader role, reporting_private schema, the Phase 2Q-A
// read RPCs, and the Phase 2Q-C export RPCs), seeds a multi-currency commerce fixture (discounted USD +
// EUR placed orders, discounted returns with pending/succeeded refunds, a supplier receipt plus an
// unattributed one, and inventory movements), then asserts the frozen export definitions: currencies
// never combined and always per-row, net-discounted return basis with the 1:1 refund attached, supplier
// receipts without any cost/spend/value, tenant isolation, the explicit RP413 row bound (never a silent
// truncation), invalid-bound/end-before-start rejection, and empty periods. It runs twice from empty.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const testFile = join(
  repositoryRoot,
  "supabase",
  "tests",
  "phase_2q_c_reporting_export_persistence.sql",
);
const expectedAssertionCount = 23;
const containerName = `clothing-commerce-reporting-export-persistence-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-reporting-export-persistence-test-only";

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
  const assertions = source.match(/pg_temp\.assert_(?:true|raises)\s*\(/giu) ?? [];

  if (assertions.length !== expectedAssertionCount) {
    throw new Error(
      `Expected ${expectedAssertionCount} reporting export persistence assertions, found ${assertions.length}.`,
    );
  }

  process.stdout.write(
    `Verified expected reporting export persistence count: ${expectedAssertionCount}.\n`,
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
    runPsql(readFileSync(testFile, "utf8"), `[cycle ${cycle}] reporting export invariants`);

    if (cycle === 1) {
      runPsql(
        [
          "drop schema if exists reporting_private cascade; drop schema if exists promotions_private cascade; drop schema if exists staff_private cascade; drop schema if exists suppliers_private cascade; drop schema if exists returns_private cascade; drop schema if exists online_private cascade; drop schema if exists offline_pos_private cascade;",
          "drop schema if exists pos_sales_private cascade;",
          "drop schema if exists payments_private cascade;",
          "drop schema if exists fulfillments_private cascade;",
          "drop schema if exists commerce_locks cascade;",
          "drop schema if exists orders_private cascade;",
          "drop schema if exists inventory_private cascade;",
          "drop schema if exists catalog_public cascade;",
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
    "Complete migrations and Phase 2Q-C reporting export persistence tests passed twice from an empty schema.\n",
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
