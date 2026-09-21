import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResources, handleInterrupts } from "./returns-test-resources.mjs";

// Disposable PostgreSQL persistence proof; applies all migrations and checks canonical returns placement.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const testFile = join(repositoryRoot, "supabase", "tests", "phase_2m_returns_persistence.sql");
const successMarker = "ALL_RETURNS_PERSISTENCE_ASSERTIONS_PASSED";
const resources = createResources();
const containerName = `postgres_${resources.projectId}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-returns-commerce-test-only";

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

const removeInterruptHandlers = handleInterrupts(() => resources.cleanup());

try {
  const start = runDocker([
    "run",
    "--detach",
    "--name",
    containerName,
    ...resources.labelArgs,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--env",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "--env",
    `POSTGRES_DB=${databaseName}`,
    postgresImage,
  ]);
  process.stdout.write(`Started PostgreSQL container ${start.stdout.trim()}\n`);

  waitForPostgres();
  createSupabaseRoleFixtures();
  applyMigrations();

  for (const fixture of [
    "phase_2h_pos_sale.setup.sql",
    "phase_2l_online.setup.sql",
    "phase_2m_returns.setup.sql",
  ]) {
    runPsql(
      readFileSync(join(repositoryRoot, "supabase", "tests", fixture), "utf8"),
      "[fixture] " + fixture,
    );
  }
  const result = runPsql(
    readFileSync(testFile, "utf8"),
    "[acceptance] Phase 2M returns persistence",
    { capture: true },
  );

  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(successMarker)) {
    throw new Error(`Returns persistence did not reach ${successMarker}.\n${output}`);
  }

  if (process.argv.includes("--suppliers")) {
    runPsql(
      readFileSync(join(repositoryRoot, "supabase/tests/phase_2n_suppliers.setup.sql"), "utf8"),
      "[fixture] suppliers",
    );
    const supplierResult = runPsql(
      readFileSync(
        join(repositoryRoot, "supabase/tests/phase_2n_suppliers_persistence.sql"),
        "utf8",
      ),
      "[acceptance] suppliers",
      { capture: true },
    );
    if (!supplierResult.stdout.includes("ALL_SUPPLIERS_PERSISTENCE_ASSERTIONS_PASSED"))
      throw new Error("Supplier persistence did not complete");
    process.stdout.write(supplierResult.stdout);
  }
  process.stdout.write(`${successMarker}\nPhase 2M returns persistence passed.\n`);
} finally {
  removeInterruptHandlers();
  resources.cleanup();
  process.stdout.write(`Removed owned PostgreSQL container ${containerName}\n`);
}
