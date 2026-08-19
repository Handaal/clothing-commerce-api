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
      containerName,
      "psql",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      "postgres",
      "--dbname",
      databaseName,
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

function waitForPostgres() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = runDocker(
      ["exec", containerName, "pg_isready", "--username", "postgres", "--dbname", databaseName],
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
  applyMigrations(1);
  runInvariantTests(1);

  runPsql(
    "drop schema public cascade; create schema public;",
    "[reset] recreated empty public schema",
  );

  applyMigrations(2);
  runInvariantTests(2);
  process.stdout.write(
    "Phase 1C-A migrations and persistence tests passed twice from an empty schema.\n",
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
