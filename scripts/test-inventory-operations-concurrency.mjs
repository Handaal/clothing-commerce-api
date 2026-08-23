import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic two-session regressions for the Phase 2C inventory operation guarantees against a
// disposable PostgreSQL instance:
//   1. Opening race: two concurrent openings of a fresh key never both establish history; exactly one
//      succeeds and the other is rejected with IN001.
//   2. Opening replay race: two concurrent openings sharing one idempotency key resolve to a single
//      operation (the loser replays), never a duplicate initialization.
//   3. Stale count race: a count adjustment holding the balance-row lock forces a concurrent count to
//      wait; when it resumes it observes the advanced version and is rejected with IN002 (never a
//      stale delta), then succeeds after refreshing the version.
// Coordination polls pg_stat_activity for genuine lock waits, never fixed timing, and every wait is
// bounded so the test cannot hang. A finally block removes only the container it created.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const containerName = `clothing-commerce-inventory-operations-concurrency-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-inventory-operations-concurrency-test-only";

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

const tenant = "10000000-0000-4000-8000-000000000001";
const variant = "60000000-0000-4000-8000-000000000001";
const locationA = "50000000-0000-4000-8000-000000000001";
const locationB = "50000000-0000-4000-8000-000000000002";
const locationC = "50000000-0000-4000-8000-000000000003";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recordOpening(locationId, quantity, idempotencyKey) {
  return `select * from inventory_private.record_opening('${tenant}', '${variant}', '${locationId}', ${quantity}, null, '${idempotencyKey}');`;
}

function recordCountAdjustment(locationId, counted, expectedVersion, idempotencyKey) {
  return `select * from inventory_private.record_count_adjustment('${tenant}', '${variant}', '${locationId}', ${counted}, ${expectedVersion}, null, '${idempotencyKey}');`;
}

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
  if (label) {
    process.stdout.write(`${label}\n`);
  }

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

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.stdout;
}

function scalar(sql) {
  const result = runDocker([
    "exec",
    "--env",
    `PGPASSWORD=${databasePassword}`,
    containerName,
    "psql",
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    ...psqlConnectionArgs,
    "--command",
    sql,
  ]);

  return result.stdout.trim();
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

// A persistent interactive psql session used to hold a transaction open across steps.
class Session {
  constructor(name) {
    this.name = name;
    this.buffer = "";
    this.marker = 0;
    this.proc = spawn(
      "docker",
      [
        "exec",
        "--interactive",
        "--env",
        `PGPASSWORD=${databasePassword}`,
        containerName,
        "psql",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=0",
        ...psqlConnectionArgs,
      ],
      { cwd: repositoryRoot },
    );
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
    });
    this.proc.stderr.on("data", (chunk) => {
      this.buffer += chunk;
    });
  }

  dispatch(sql) {
    const marker = `__DONE_${this.name}_${(this.marker += 1)}__`;
    this.proc.stdin.write(`${sql}\n\\echo ${marker}\n`);
    return marker;
  }

  async waitForMarker(marker, timeoutMs = 30000) {
    const start = Date.now();
    while (!this.buffer.includes(marker)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`${this.name} timed out waiting for ${marker}`);
      }
      await delay(50);
    }
  }

  async run(sql, timeoutMs = 30000) {
    await this.waitForMarker(this.dispatch(sql), timeoutMs);
  }

  bufferIncludes(text) {
    return this.buffer.includes(text);
  }

  async close() {
    try {
      this.proc.stdin.end();
    } catch {
      // The process may already be gone; cleanup is best effort.
    }
  }
}

function sessionsBlockedOn(functionName) {
  return Number(
    scalar(
      "select count(*) from pg_stat_activity where state = 'active' " +
        `and wait_event_type = 'Lock' and query like '%${functionName}%';`,
    ),
  );
}

async function waitUntilBlocked(functionName, timeoutMs = 15000) {
  const start = Date.now();
  while (sessionsBlockedOn(functionName) < 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`the second session never blocked while calling ${functionName}`);
    }
    await delay(100);
  }
}

let passed = 0;
function check(condition, label) {
  if (condition !== true) {
    throw new Error(`concurrency assertion failed: ${label}`);
  }
  passed += 1;
  process.stdout.write(`  ok - ${label}\n`);
}

function seedFixtures() {
  runPsql(
    `
    insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
    values ('${tenant}', 'inv-ops-concurrency', 'Inventory Ops Concurrency', 'active', 'completed', 'USD');

    insert into public.brands (id, tenant_id, code, display_name)
    values ('20000000-0000-4000-8000-000000000001', '${tenant}', 'A', 'Brand A');

    insert into public.products (id, tenant_id, brand_id, name, slug, status)
    values ('30000000-0000-4000-8000-000000000001', '${tenant}', '20000000-0000-4000-8000-000000000001', 'Prod A', 'prod-a', 'active');

    insert into public.product_variants (id, tenant_id, product_id, sku, status)
    values ('${variant}', '${tenant}', '30000000-0000-4000-8000-000000000001', 'SKU-A1', 'active');

    insert into public.branches (id, tenant_id, code, display_name, timezone)
    values ('b0000000-0000-4000-8000-000000000001', '${tenant}', 'BRA', 'Branch A', 'UTC');

    insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type)
    values
      ('${locationA}', '${tenant}', 'b0000000-0000-4000-8000-000000000001', 'LOC-A1', 'Floor A1', 'sales_floor'),
      ('${locationB}', '${tenant}', 'b0000000-0000-4000-8000-000000000001', 'LOC-A2', 'Stock A2', 'stockroom'),
      ('${locationC}', '${tenant}', 'b0000000-0000-4000-8000-000000000001', 'LOC-A3', 'Floor A3', 'sales_floor');
    `,
    "[seed] tenant, brand, product, variant, and three locations",
  );
}

function movementCount(locationId) {
  return scalar(
    `select count(*) from public.inventory_movements ` +
      `where tenant_id = '${tenant}' and variant_id = '${variant}' and inventory_location_id = '${locationId}';`,
  );
}

function onHand(locationId) {
  return scalar(
    `select coalesce((select on_hand_quantity::text from public.inventory_balances ` +
      `where tenant_id = '${tenant}' and variant_id = '${variant}' ` +
      `and inventory_location_id = '${locationId}'), 'none');`,
  );
}

async function openingRace() {
  process.stdout.write("Scenario 1: two concurrent openings of a fresh key\n");
  const sessionOne = new Session("s1");
  const sessionTwo = new Session("s2");
  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    // T1 opens +10 and holds the balance-row lock open (uncommitted).
    await sessionOne.run("begin;");
    await sessionOne.run(recordOpening(locationA, 10, "open-race-t1"));

    // T2 concurrently opens +20 under a different key; it must block on T1's row lock.
    await sessionTwo.run("begin;");
    const t2Marker = sessionTwo.dispatch(recordOpening(locationA, 20, "open-race-t2"));
    await waitUntilBlocked("record_opening");
    check(true, "the second opening blocks on the balance row lock");

    // Releasing T1 lets T2 observe the committed opening and be rejected atomically.
    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(t2Marker);
    check(
      sessionTwo.bufferIncludes("opening stock already exists"),
      "the second opening is rejected with the opening-already-exists error",
    );
    await sessionTwo.run("rollback;");

    check(onHand(locationA) === "10", "exactly the winning opening quantity is on hand");
    check(movementCount(locationA) === "1", "only one opening movement was committed");
  } finally {
    await sessionOne.close();
    await sessionTwo.close();
  }
}

async function openingReplayRace() {
  process.stdout.write("Scenario 2: two concurrent openings sharing one idempotency key\n");
  const sessionOne = new Session("s3");
  const sessionTwo = new Session("s4");
  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    await sessionOne.run("begin;");
    await sessionOne.run(recordOpening(locationB, 10, "open-replay-shared"));

    await sessionTwo.run("begin;");
    const t2Marker = sessionTwo.dispatch(recordOpening(locationB, 10, "open-replay-shared"));
    await waitUntilBlocked("record_opening");
    check(true, "the second identical-key opening blocks on the balance row lock");

    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(t2Marker);
    check(
      !sessionTwo.bufferIncludes("opening stock already exists"),
      "the shared-key opening replays instead of failing",
    );
    await sessionTwo.run("commit;");

    check(onHand(locationB) === "10", "the shared opening is applied exactly once");
    check(movementCount(locationB) === "1", "the shared-key opening produced one movement");
    check(
      scalar(
        `select count(*) from public.inventory_operations where operation_type = 'opening' ` +
          `and tenant_id = '${tenant}' and normalized_idempotency_key = 'open-replay-shared';`,
      ) === "1",
      "exactly one opening operation exists for the shared key",
    );
  } finally {
    await sessionOne.close();
    await sessionTwo.close();
  }
}

async function staleCountRace() {
  process.stdout.write("Scenario 3: a concurrent count cannot apply a stale delta\n");
  // Establish opening stock of 5 (version 1) at a fresh location.
  runPsql(recordOpening(locationC, 5, "count-open"));
  check(onHand(locationC) === "5", "opening stock at the count location is 5");

  const sessionOne = new Session("s5");
  const sessionTwo = new Session("s6");
  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    // T1 reconciles to 8 (version 1 -> 2) and holds the balance-row lock open.
    await sessionOne.run("begin;");
    await sessionOne.run(recordCountAdjustment(locationC, 8, 1, "count-t1"));

    // T2 attempts a count that was taken against the now-stale version 1; it must block, then fail.
    await sessionTwo.run("begin;");
    const t2Marker = sessionTwo.dispatch(recordCountAdjustment(locationC, 6, 1, "count-t2"));
    await waitUntilBlocked("record_count_adjustment");
    check(true, "the stale count blocks on the balance row lock");

    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(t2Marker);
    check(
      sessionTwo.bufferIncludes("balance changed since it was read"),
      "the stale count is rejected with the concurrent-modification error",
    );
    await sessionTwo.run("rollback;");

    check(onHand(locationC) === "8", "the committed count wins and no stale delta is applied");

    // After refreshing to the current version the retry succeeds.
    runPsql(recordCountAdjustment(locationC, 6, 2, "count-t2-retry"));
    check(onHand(locationC) === "6", "the refreshed retry reconciles to the counted quantity");
  } finally {
    await sessionOne.close();
    await sessionTwo.close();
  }
}

runDocker(["version", "--format", "Docker engine {{.Server.Version}}"]);

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
  runPsql(
    [
      "create role anon nologin noinherit;",
      "create role authenticated nologin noinherit;",
      "create role service_role nologin noinherit bypassrls;",
    ].join("\n"),
    "[setup] created local Supabase role fixtures",
  );
  applyMigrations();
  seedFixtures();

  await openingRace();
  await openingReplayRace();
  await staleCountRace();

  process.stdout.write(
    `Phase 2C inventory operation concurrency regression passed (${passed} deterministic checks).\n`,
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
