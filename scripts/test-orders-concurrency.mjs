import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic two-session regressions for the Phase 2D order guarantees against a disposable
// PostgreSQL instance:
//   1. Idempotent create race: two concurrent creates sharing one key + intent resolve to a single
//      order (the loser replays), never a duplicate; no order number is burned by the loser.
//   2. Conflicting create race: same key, different intent -> exactly one order; the loser is ID409.
//   3. Order-number race: two concurrent creates of different keys serialize on the per-tenant counter
//      and receive distinct sequential numbers, never a MAX()+1 duplicate.
//   4. Cancel race: two concurrent cancels of one order -> exactly one transition writes metadata; the
//      loser observes the already-cancelled state and does not overwrite it.
//   5. Absent-counter-row race: two concurrent first creates for a tenant with NO order_number_sequences
//      row -> the initialization loser traverses the unique_violation retry branch, both succeed with
//      distinct numbers, exactly one counter row exists, and there is no deadlock or duplicate number.
// Coordination polls pg_stat_activity for genuine lock waits, never fixed timing; every wait is bounded.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const containerName = `clothing-commerce-orders-concurrency-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-orders-concurrency-test-only";

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
const brand = "20000000-0000-4000-8000-000000000001";
const product = "30000000-0000-4000-8000-000000000001";
const variant = "60000000-0000-4000-8000-000000000001";
const branch = "b0000000-0000-4000-8000-000000000001";
const register = "c0000000-0000-4000-8000-000000000001";
const membership = "71000000-0000-4000-8000-000000000001";
const userIdentity = "70000000-0000-4000-8000-000000000001";

// A pristine second tenant whose order_number_sequences row does NOT yet exist, used only to race the
// absent-counter-row initialization path (scenario 5). Kept separate so no earlier scenario creates
// the sequence row first.
const tenant2 = "10000000-0000-4000-8000-0000000000f2";
const brand2 = "20000000-0000-4000-8000-0000000000f2";
const product2 = "30000000-0000-4000-8000-0000000000f2";
const variant2 = "60000000-0000-4000-8000-0000000000f2";
const branch2 = "b0000000-0000-4000-8000-0000000000f2";
const register2 = "c0000000-0000-4000-8000-0000000000f2";
const membership2 = "71000000-0000-4000-8000-0000000000f2";
const userIdentity2 = "70000000-0000-4000-8000-0000000000f2";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createOrderSql(key, quantity) {
  return (
    `select orders_private.create_order('${tenant}','pos','USD','${brand}','${branch}','${register}',` +
    `'${membership}','${key}', null, null, ` +
    `'[{"variant_id":"${variant}","product_id":"${product}","quantity":${quantity},` +
    `"unit_price_minor":1000,"product_name":"P","sku":"S"}]'::jsonb);`
  );
}

function createOrder2Sql(key, quantity) {
  return (
    `select orders_private.create_order('${tenant2}','pos','USD','${brand2}','${branch2}','${register2}',` +
    `'${membership2}','${key}', null, null, ` +
    `'[{"variant_id":"${variant2}","product_id":"${product2}","quantity":${quantity},` +
    `"unit_price_minor":1000,"product_name":"P","sku":"S"}]'::jsonb);`
  );
}

function cancelSql(orderId, reason) {
  return `select * from orders_private.cancel_order('${tenant}','${orderId}','${membership}','${reason}');`;
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
      // best effort
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
    values ('${tenant}', 'ord-conc', 'Orders Concurrency', 'active', 'completed', 'USD');
    insert into public.user_identities (id, display_name, primary_email)
    values ('${userIdentity}', 'U', 'u@example.test');
    insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
    values ('${membership}', '${tenant}', '${userIdentity}', 'active', now(), now());
    insert into public.brands (id, tenant_id, code, display_name)
    values ('${brand}', '${tenant}', 'A', 'Brand A');
    insert into public.products (id, tenant_id, brand_id, name, slug, status)
    values ('${product}', '${tenant}', '${brand}', 'P', 'p', 'active');
    insert into public.product_variants (id, tenant_id, product_id, sku, status)
    values ('${variant}', '${tenant}', '${product}', 'S', 'active');
    insert into public.branches (id, tenant_id, code, display_name, timezone)
    values ('${branch}', '${tenant}', 'BRA', 'Branch A', 'UTC');
    insert into public.registers (id, tenant_id, branch_id, code, display_name, status)
    values ('${register}', '${tenant}', '${branch}', 'REG', 'Reg', 'inactive');
    `,
    "[seed] tenant, membership, brand, product, variant, branch, register",
  );
}

function seedAbsentCounterTenant() {
  runPsql(
    `
    insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
    values ('${tenant2}', 'ord-conc-2', 'Orders Concurrency 2', 'active', 'completed', 'USD');
    insert into public.user_identities (id, display_name, primary_email)
    values ('${userIdentity2}', 'U2', 'u2@example.test');
    insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
    values ('${membership2}', '${tenant2}', '${userIdentity2}', 'active', now(), now());
    insert into public.brands (id, tenant_id, code, display_name)
    values ('${brand2}', '${tenant2}', 'A2', 'Brand A2');
    insert into public.products (id, tenant_id, brand_id, name, slug, status)
    values ('${product2}', '${tenant2}', '${brand2}', 'P2', 'p2', 'active');
    insert into public.product_variants (id, tenant_id, product_id, sku, status)
    values ('${variant2}', '${tenant2}', '${product2}', 'S2', 'active');
    insert into public.branches (id, tenant_id, code, display_name, timezone)
    values ('${branch2}', '${tenant2}', 'BRA2', 'Branch A2', 'UTC');
    insert into public.registers (id, tenant_id, branch_id, code, display_name, status)
    values ('${register2}', '${tenant2}', '${branch2}', 'REG2', 'Reg2', 'inactive');
    `,
    "[seed] pristine second tenant with NO order_number_sequences row",
  );
}

function orderCountForKey(key) {
  return scalar(
    `select count(*) from public.orders where tenant_id = '${tenant}' and normalized_idempotency_key = '${key}';`,
  );
}

async function idempotentCreateRace() {
  process.stdout.write("Scenario 1: concurrent create with same key + same intent\n");
  const s1 = new Session("s1");
  const s2 = new Session("s2");
  try {
    await s1.run("select 1;");
    await s2.run("select 1;");
    await s1.run("begin;");
    await s1.run(createOrderSql("race-same", 2));
    await s2.run("begin;");
    const marker = s2.dispatch(createOrderSql("race-same", 2));
    await waitUntilBlocked("create_order");
    check(true, "the second concurrent create blocks on the order-number counter");
    await s1.run("commit;");
    await s2.waitForMarker(marker);
    await s2.run("commit;");
    check(orderCountForKey("race-same") === "1", "exactly one order exists for the shared key");
  } finally {
    await s1.close();
    await s2.close();
  }
}

async function conflictingCreateRace() {
  process.stdout.write("Scenario 2: concurrent create with same key + different intent\n");
  const s1 = new Session("c1");
  const s2 = new Session("c2");
  try {
    await s1.run("select 1;");
    await s2.run("select 1;");
    await s1.run("begin;");
    await s1.run(createOrderSql("race-diff", 2));
    await s2.run("begin;");
    const marker = s2.dispatch(createOrderSql("race-diff", 5));
    await waitUntilBlocked("create_order");
    await s1.run("commit;");
    await s2.waitForMarker(marker);
    check(
      s2.bufferIncludes("different order intent"),
      "the conflicting create loser is rejected with ID409",
    );
    await s2.run("rollback;");
    check(orderCountForKey("race-diff") === "1", "only one order exists for the conflicting key");
  } finally {
    await s1.close();
    await s2.close();
  }
}

async function orderNumberRace() {
  process.stdout.write(
    "Scenario 3: concurrent creates of different keys receive distinct numbers\n",
  );
  const s1 = new Session("n1");
  const s2 = new Session("n2");
  try {
    await s1.run("select 1;");
    await s2.run("select 1;");
    await s1.run("begin;");
    await s1.run(createOrderSql("num-a", 1));
    await s2.run("begin;");
    const marker = s2.dispatch(createOrderSql("num-b", 1));
    await waitUntilBlocked("create_order");
    await s1.run("commit;");
    await s2.waitForMarker(marker);
    await s2.run("commit;");
    const distinct = scalar(
      `select count(distinct order_number) from public.orders where tenant_id = '${tenant}' ` +
        `and normalized_idempotency_key in ('num-a','num-b');`,
    );
    check(distinct === "2", "the two concurrent creates received distinct order numbers");
  } finally {
    await s1.close();
    await s2.close();
  }
}

async function absentCounterRowRace() {
  process.stdout.write(
    "Scenario 5: concurrent first creates on a tenant with NO order-number counter row\n",
  );
  // Precondition: the pristine tenant has no order_number_sequences row yet, so both sessions enter
  // create_order's absent-row initialization path. The first to INSERT the counter row wins; the
  // second necessarily contends on the primary-key unique index and must traverse the unique_violation
  // retry branch (re-lock the now-committed row, then increment). This proves that path never escapes a
  // unique violation, never deadlocks, never creates a duplicate counter row, and never duplicates a
  // number. (A "both sessions observe the row absent before either INSERTs" interleaving is not
  // deterministically forceable without an in-function pause hook, which would require altering the
  // sanctioned numbering function -- out of scope; the protective retry branch is exercised here.)
  const before = scalar(
    `select count(*) from public.order_number_sequences where tenant_id = '${tenant2}';`,
  );
  check(before === "0", "the second tenant starts with no order-number counter row");

  const s1 = new Session("a1");
  const s2 = new Session("a2");
  try {
    await s1.run("select 1;");
    await s2.run("select 1;");
    await s1.run("begin;");
    await s1.run(createOrder2Sql("absent-a", 1));
    await s2.run("begin;");
    const marker = s2.dispatch(createOrder2Sql("absent-b", 1));
    await waitUntilBlocked("create_order");
    check(true, "the second concurrent create blocks initializing the absent counter row");
    await s1.run("commit;");
    await s2.waitForMarker(marker);
    check(
      !s2.bufferIncludes("duplicate key") && !s2.bufferIncludes("deadlock"),
      "the counter-init loser escaped no unique violation and no deadlock",
    );
    await s2.run("commit;");

    const rows = scalar(
      `select count(*) from public.order_number_sequences where tenant_id = '${tenant2}';`,
    );
    check(rows === "1", "exactly one order-number counter row exists for the tenant");
    const distinct = scalar(
      `select count(distinct order_number) from public.orders where tenant_id = '${tenant2}' ` +
        `and normalized_idempotency_key in ('absent-a','absent-b');`,
    );
    check(distinct === "2", "the two concurrent first creates received distinct order numbers");
    const nextValue = scalar(
      `select next_value from public.order_number_sequences where tenant_id = '${tenant2}';`,
    );
    check(
      nextValue === "2",
      "the counter advanced exactly twice with no burned or duplicated value",
    );
  } finally {
    await s1.close();
    await s2.close();
  }
}

async function cancelRace() {
  process.stdout.write("Scenario 4: concurrent cancels of one order\n");
  runPsql(createOrderSql("cancel-race", 1), "[seed] order to cancel");
  const orderId = scalar(
    `select id from public.orders where tenant_id = '${tenant}' and normalized_idempotency_key = 'cancel-race';`,
  );
  const s1 = new Session("x1");
  const s2 = new Session("x2");
  try {
    await s1.run("select 1;");
    await s2.run("select 1;");
    await s1.run("begin;");
    await s1.run(cancelSql(orderId, "winner"));
    await s2.run("begin;");
    const marker = s2.dispatch(cancelSql(orderId, "loser"));
    await waitUntilBlocked("cancel_order");
    await s1.run("commit;");
    await s2.waitForMarker(marker);
    await s2.run("commit;");
    const reason = scalar(`select cancellation_reason from public.orders where id = '${orderId}';`);
    check(reason === "winner", "the cancel loser does not overwrite the original metadata");
  } finally {
    await s1.close();
    await s2.close();
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

runDocker(["version", "--format", "{{.Server.Version}}"]);
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
  seedFixtures();
  seedAbsentCounterTenant();

  await idempotentCreateRace();
  await conflictingCreateRace();
  await orderNumberRace();
  await absentCounterRowRace();
  await cancelRace();

  process.stdout.write(`\nAll ${passed} Phase 2D order concurrency assertions passed.\n`);
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
