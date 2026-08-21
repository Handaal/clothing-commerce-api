import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic two-session regressions for the inventory balance concurrency guarantees. Against a
// real, disposable PostgreSQL instance it proves three things:
//   1. Oversell race: with stock = 1, two concurrent -1 deductions never both succeed; exactly one
//      commits, the balance floors at 0, and only the committed deduction reaches the ledger.
//   2. First-balance creation race: two concurrent positive movements to a not-yet-existing
//      (tenant, variant, location) key produce exactly one balance row summing both deltas.
//   3. Independent keys do not serialize: a held lock on one location's balance never blocks a
//      mutation on a different location's balance.
// Coordination polls pg_stat_activity for genuine lock waits, never fixed timing, and every wait is
// bounded so the test cannot hang. A finally block removes only the container it created.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const containerName = `clothing-commerce-inventory-concurrency-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-inventory-concurrency-test-only";

// Every client connects over container-internal TCP (127.0.0.1), never an implicit Unix socket, so
// the official image's socket-only init server can never race the real server's startup. This is
// the same portable pattern used by the catalog concurrency runner.
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
// Two locations kept pristine (never touched by scenarios 1-6) so their balance rows are absent
// when the opposing multi-key creation race runs. locationC < locationD by UUID, so with one variant
// the canonical (variant, location) order is locationC then locationD.
const locationC = "50000000-0000-4000-8000-000000000003";
const locationD = "50000000-0000-4000-8000-000000000004";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function movement(locationId, delta) {
  return JSON.stringify([
    { variant_id: variant, inventory_location_id: locationId, quantity_delta: delta },
  ]);
}

function recordOperation(operationType, locationId, delta, idempotencyKey) {
  const movements = movement(locationId, delta).replaceAll("'", "''");
  const key = idempotencyKey ? `'${idempotencyKey}'` : "null";
  return `select inventory_private.record_operation('${tenant}', '${operationType}', '${movements}'::jsonb, null, ${key});`;
}

// Builds a record_operation call with an ordered list of [locationId, delta] lines (one variant),
// so a test can submit the same keys in different payload orders.
function recordMulti(operationType, lines, idempotencyKey) {
  const movements = JSON.stringify(
    lines.map(([locationId, delta]) => ({
      variant_id: variant,
      inventory_location_id: locationId,
      quantity_delta: delta,
    })),
  ).replaceAll("'", "''");
  const key = idempotencyKey ? `'${idempotencyKey}'` : "null";
  return `select inventory_private.record_operation('${tenant}', '${operationType}', '${movements}'::jsonb, null, ${key});`;
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

// Counts sessions genuinely blocked on a heavyweight lock while executing record_operation. A
// balance-row conflict makes the waiter block on a tuple/transaction lock (wait_event_type 'Lock').
function sessionsBlockedInRecordOperation() {
  return Number(
    scalar(
      "select count(*) from pg_stat_activity where state = 'active' " +
        "and wait_event_type = 'Lock' and query like '%record_operation%';",
    ),
  );
}

async function waitUntilBlocked(timeoutMs = 15000) {
  const start = Date.now();
  while (sessionsBlockedInRecordOperation() < 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("the second session never blocked on the balance row lock");
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
    values ('${tenant}', 'inv-concurrency', 'Inventory Concurrency', 'active', 'completed', 'USD');

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
      ('${locationC}', '${tenant}', 'b0000000-0000-4000-8000-000000000001', 'LOC-A3', 'Floor A3', 'sales_floor'),
      ('${locationD}', '${tenant}', 'b0000000-0000-4000-8000-000000000001', 'LOC-A4', 'Stock A4', 'stockroom');
    `,
    "[seed] tenant, brand, product, variant, and four locations",
  );
}

function ledgerSum(locationId) {
  return scalar(
    `select coalesce(sum(quantity_delta), 0) from public.inventory_movements ` +
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

async function oversellRace() {
  process.stdout.write("Scenario 1: oversell race on a single balance row\n");
  // Opening stock of exactly 1 at location A, committed.
  runPsql(recordOperation("opening", locationA, 1, "oversell-open"));
  check(onHand(locationA) === "1", "opening stock at location A is 1");

  const sessionOne = new Session("s1");
  const sessionTwo = new Session("s2");
  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    // T1 deducts 1 and holds the balance row lock open (uncommitted).
    await sessionOne.run("begin;");
    await sessionOne.run(recordOperation("sale", locationA, -1, "oversell-t1"));

    // T2 concurrently attempts the same deduction; it must block on T1's row lock.
    await sessionTwo.run("begin;");
    const t2Marker = sessionTwo.dispatch(recordOperation("sale", locationA, -1, "oversell-t2"));
    await waitUntilBlocked();
    check(true, "the second deduction blocks on the balance row lock");

    // Releasing T1 lets T2 re-read the committed balance (0) and be rejected atomically.
    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(t2Marker);
    const t2Rejected = sessionTwo.bufferIncludes("insufficient stock");
    check(t2Rejected, "the second deduction is rejected as insufficient stock");
    await sessionTwo.run("rollback;");

    check(onHand(locationA) === "0", "final on-hand floors at 0");
    check(ledgerSum(locationA) === "0", "the ledger sum equals the balance");
    check(
      scalar(
        `select count(*) from public.inventory_movements where quantity_delta = -1 ` +
          `and inventory_location_id = '${locationA}';`,
      ) === "1",
      "exactly one deduction movement was committed",
    );
  } finally {
    await sessionOne.close();
    await sessionTwo.close();
  }
}

async function firstBalanceCreationRace() {
  process.stdout.write("Scenario 2: concurrent first movements to an absent balance\n");
  check(onHand(locationB) === "none", "location B has no balance row yet");

  const sessionOne = new Session("c1");
  const sessionTwo = new Session("c2");
  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    // T1 creates the first balance row (+5) and holds it uncommitted.
    await sessionOne.run("begin;");
    await sessionOne.run(recordOperation("opening", locationB, 5, "create-t1"));

    // T2 concurrently adds +7 to the same absent key; its insert blocks on T1's uncommitted row.
    await sessionTwo.run("begin;");
    const t2Marker = sessionTwo.dispatch(recordOperation("opening", locationB, 7, "create-t2"));
    await waitUntilBlocked();
    check(true, "the second creation blocks on the pending unique balance row");

    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(t2Marker);
    await sessionTwo.run("commit;");

    check(
      scalar(
        `select count(*) from public.inventory_balances where inventory_location_id = '${locationB}';`,
      ) === "1",
      "exactly one balance row exists for the contested key",
    );
    check(onHand(locationB) === "12", "both additions are preserved (5 + 7 = 12)");
    check(ledgerSum(locationB) === "12", "the ledger sum equals the balance");
  } finally {
    await sessionOne.close();
    await sessionTwo.close();
  }
}

async function independentKeysDoNotSerialize() {
  process.stdout.write("Scenario 3: independent location keys do not serialize\n");
  const sessionOne = new Session("i1");
  try {
    await sessionOne.run("select 1;");
    // T1 locks location A's balance row and holds it open.
    await sessionOne.run("begin;");
    await sessionOne.run(recordOperation("adjustment", locationA, 1, "indep-t1"));

    // A separate session mutates location B under a short timeout; a per-key lock must not block it.
    const before = Date.now();
    runPsql(
      `set statement_timeout = '5s';\n${recordOperation("adjustment", locationB, 1, "indep-t2")}`,
    );
    const elapsed = Date.now() - before;
    check(elapsed < 5000, "a mutation on location B is not blocked by a lock on location A");

    await sessionOne.run("commit;");
    check(onHand(locationB) === "13", "location B reflects its own committed mutation (12 + 1)");
  } finally {
    await sessionOne.close();
  }
}

async function opposingMultiKeyDoNotDeadlock() {
  process.stdout.write("Scenario 4: opposing multi-key operations serialize without deadlock\n");
  // Both keys already have balance rows. Canonical lock order is (variant, location); with one
  // variant that is location ascending, so locationA is the canonical-first key.
  const beforeA = Number(onHand(locationA));
  const beforeB = Number(onHand(locationB));

  const holder = new Session("h");
  const sessionA = new Session("m1");
  const sessionB = new Session("m2");
  try {
    for (const session of [holder, sessionA, sessionB]) {
      await session.run("select 1;");
      await session.run("set statement_timeout = '20s';");
    }

    // The holder locks the canonical-first key and keeps it open, so both operations must wait on it.
    await holder.run("begin;");
    await holder.run(
      `select on_hand_quantity from public.inventory_balances ` +
        `where tenant_id = '${tenant}' and variant_id = '${variant}' ` +
        `and inventory_location_id = '${locationA}' for update;`,
    );

    // Opposite payload orders. Under payload-order locking these would deadlock; canonical ordering
    // forces both to request locationA first, so they queue on the holder instead of cycling.
    const markerA = sessionA.dispatch(
      recordMulti("transfer", [
        [locationB, 1],
        [locationA, 1],
      ]),
    );
    const markerB = sessionB.dispatch(
      recordMulti("transfer", [
        [locationA, 1],
        [locationB, 1],
      ]),
    );

    const start = Date.now();
    while (sessionsBlockedInRecordOperation() < 2 && Date.now() - start < 12000) {
      await delay(150);
    }
    check(
      sessionsBlockedInRecordOperation() >= 2,
      "both opposing operations block on the canonical-first key",
    );

    await holder.run("commit;");
    await sessionA.waitForMarker(markerA);
    await sessionB.waitForMarker(markerB);

    check(
      !sessionA.bufferIncludes("deadlock") &&
        !sessionA.bufferIncludes("40P01") &&
        !sessionB.bufferIncludes("deadlock") &&
        !sessionB.bufferIncludes("40P01"),
      "neither opposing operation aborts with a deadlock (SQLSTATE 40P01)",
    );
    check(
      Number(onHand(locationA)) === beforeA + 2 && Number(onHand(locationB)) === beforeB + 2,
      "both operations committed their deltas on both keys",
    );
  } finally {
    await holder.close();
    await sessionA.close();
    await sessionB.close();
  }
}

async function concurrentIdenticalIdempotency() {
  process.stdout.write("Scenario 5: concurrent identical idempotency applies stock exactly once\n");
  const key = "concurrent-same";
  const before = Number(onHand(locationA));

  const sessionOne = new Session("k1");
  const sessionTwo = new Session("k2");
  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    // T1 records the operation and holds it uncommitted, so its idempotency row is invisible to T2.
    await sessionOne.run("begin;");
    await sessionOne.run(recordMulti("adjustment", [[locationA, 3]], key));

    // T2 submits the same key + same payload; its operation insert blocks on the pending unique key.
    await sessionTwo.run("begin;");
    const markerTwo = sessionTwo.dispatch(recordMulti("adjustment", [[locationA, 3]], key));
    await waitUntilBlocked();
    check(true, "the second identical submission blocks on the pending idempotency key");

    // Once T1 commits, T2 resolves to the same operation and applies nothing further.
    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(markerTwo);
    check(
      !sessionTwo.bufferIncludes("ID409") && !sessionTwo.bufferIncludes("ERROR"),
      "the second identical submission resolves without error",
    );
    await sessionTwo.run("commit;");

    check(
      scalar(
        `select count(*) from public.inventory_operations where normalized_idempotency_key = '${key}';`,
      ) === "1",
      "exactly one operation exists for the shared key",
    );
    check(Number(onHand(locationA)) === before + 3, "the shared payload is applied exactly once");
  } finally {
    await sessionOne.close();
    await sessionTwo.close();
  }
}

async function concurrentConflictingIdempotency() {
  process.stdout.write(
    "Scenario 6: concurrent conflicting idempotency yields one winner and one mismatch\n",
  );
  const key = "concurrent-diff";
  const before = Number(onHand(locationA));

  const sessionOne = new Session("d1");
  const sessionTwo = new Session("d2");
  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    // T1 records +3 under the key and holds it uncommitted.
    await sessionOne.run("begin;");
    await sessionOne.run(recordMulti("adjustment", [[locationA, 3]], key));

    // T2 submits the same key with a DIFFERENT payload (+4); its insert blocks on the pending key.
    await sessionTwo.run("begin;");
    const markerTwo = sessionTwo.dispatch(recordMulti("adjustment", [[locationA, 4]], key));
    await waitUntilBlocked();
    check(true, "the conflicting submission blocks on the pending idempotency key");

    // After T1 commits, T2 sees the mismatching fingerprint and is rejected deterministically.
    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(markerTwo);
    check(
      sessionTwo.bufferIncludes("ID409") || sessionTwo.bufferIncludes("different payload"),
      "the conflicting submission is rejected with the idempotency mismatch error",
    );
    await sessionTwo.run("rollback;");

    check(
      scalar(
        `select count(*) from public.inventory_operations where normalized_idempotency_key = '${key}';`,
      ) === "1",
      "only the winning operation exists for the key",
    );
    check(Number(onHand(locationA)) === before + 3, "only the winning payload is applied");
  } finally {
    await sessionOne.close();
    await sessionTwo.close();
  }
}

async function opposingAbsentMultiKeyDoNotDeadlock() {
  process.stdout.write(
    "Scenario 7: opposing multi-key creation of absent balances does not deadlock\n",
  );
  // locationC and locationD have never been touched, so both balance rows are absent. With one
  // variant the canonical key order is (variant, locationC) then (variant, locationD). This exercises
  // the unique-index insertion + absent-row creation + canonical ordering interaction together.
  check(
    onHand(locationC) === "none" && onHand(locationD) === "none",
    "both contested keys start with no balance row",
  );

  const sessionA = new Session("a1");
  const sessionB = new Session("a2");
  try {
    await sessionA.run("select 1;");
    await sessionB.run("select 1;");
    await sessionB.run("set statement_timeout = '20s';");

    // A creates both absent rows and holds them uncommitted. Its payload lists D before C, but pass 2
    // creates/locks in canonical order (C then D).
    await sessionA.run("begin;");
    await sessionA.run(
      recordMulti("opening", [
        [locationD, 7],
        [locationC, 5],
      ]),
    );

    // B submits the same two keys in the opposite payload order. It also canonicalizes to C first, so
    // it must block on A's pending unique insert for locationC — never form a cycle on locationD.
    await sessionB.run("begin;");
    const markerB = sessionB.dispatch(
      recordMulti("opening", [
        [locationC, 3],
        [locationD, 9],
      ]),
    );
    await waitUntilBlocked();
    check(true, "the second creation blocks on the pending canonical-first balance insert");

    await sessionA.run("commit;");
    await sessionB.waitForMarker(markerB);
    check(
      !sessionB.bufferIncludes("deadlock") && !sessionB.bufferIncludes("40P01"),
      "neither opposing creation aborts with a deadlock (SQLSTATE 40P01)",
    );
    await sessionB.run("commit;");

    check(
      scalar(
        `select count(*) from public.inventory_balances ` +
          `where inventory_location_id in ('${locationC}', '${locationD}');`,
      ) === "2",
      "exactly one balance row exists per contested key (no duplicates)",
    );
    check(
      onHand(locationC) === "8" && onHand(locationD) === "16",
      "both operations' deltas are preserved (C = 5 + 3, D = 7 + 9)",
    );
    check(
      ledgerSum(locationC) === "8" && ledgerSum(locationD) === "16",
      "ledger sums equal the balances for both contested keys",
    );
  } finally {
    await sessionA.close();
    await sessionB.close();
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

  await oversellRace();
  await firstBalanceCreationRace();
  await independentKeysDoNotSerialize();
  await opposingMultiKeyDoNotDeadlock();
  await opposingAbsentMultiKeyDoNotDeadlock();
  await concurrentIdenticalIdempotency();
  await concurrentConflictingIdempotency();

  process.stdout.write(
    `Phase 2B inventory concurrency regression passed (${passed} deterministic checks).\n`,
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
