import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic two-session regressions for the Phase 2E fulfillment guarantees against a disposable
// PostgreSQL instance. Every race is coordinated by holding the relevant lock in an open transaction in
// session 1 and polling pg_stat_activity until session 2 genuinely blocks -- never fixed timing:
//   A. Same idempotency key + intent      -> exactly one Fulfillment and one InventoryOperation.
//   B. Same key, different intent          -> exactly one Fulfillment; the loser is ID409.
//   C. Over-fulfillment race               -> line qty 5, two qty-4 requests, high stock; one succeeds,
//                                             the other OVER_FULFILLMENT; total fulfilled is 4.
//   D. Cancel vs fulfill (both directions) -> exactly one winner; "cancelled Order + Fulfillment" is
//                                             impossible; when cancel wins no inventory is issued.
//   E. Different Orders, same Location      -> serialize on the Location lifecycle lock, no deadlock.
//   F. Fulfillment vs generic inventory     -> serialize on the balance row lock, no negative stock,
//      issue                                   no deadlock.
//   G. Location lifecycle race              -> using a lock-abiding test-only lifecycle mutation, either
//                                             the Fulfillment wins then the Location deactivates, or the
//                                             deactivation wins then the Fulfillment fails; a replay
//                                             after deactivation returns the original and never
//                                             re-issues.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const containerName = `clothing-commerce-fulfillment-concurrency-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-fulfillment-concurrency-test-only";

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
const userIdentity = "70000000-0000-4000-8000-000000000001";
const membership = "71000000-0000-4000-8000-000000000001";
const brand = "20000000-0000-4000-8000-000000000001";
const product = "30000000-0000-4000-8000-000000000001";
const variant = "60000000-0000-4000-8000-000000000001";
const branch = "b0000000-0000-4000-8000-000000000001";
const locMain = "e0000000-0000-4000-8000-000000000001";
const locG = "e0000000-0000-4000-8000-000000000002";
const locG2 = "e0000000-0000-4000-8000-000000000003";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout}\n${result.stderr}\n`);
    throw new Error(`psql failed: ${label}`);
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
    this.proc.stdout.on("data", (chunk) => (this.buffer += chunk));
    this.proc.stderr.on("data", (chunk) => (this.buffer += chunk));
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

  clearBuffer() {
    this.buffer = "";
  }

  async close() {
    try {
      this.proc.stdin.end();
    } catch {
      // best effort
    }
  }
}

function sessionsBlockedOn(fragment) {
  return Number(
    scalar(
      "select count(*) from pg_stat_activity where state = 'active' " +
        `and wait_event_type = 'Lock' and query like '%${fragment}%';`,
    ),
  );
}

async function waitUntilBlocked(fragment, timeoutMs = 15000) {
  const start = Date.now();
  while (sessionsBlockedOn(fragment) < 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`the second session never blocked on ${fragment}`);
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
    values ('${tenant}', 'ff-conc', 'FF Concurrency', 'active', 'completed', 'USD');
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
    insert into public.branches (id, tenant_id, code, display_name, timezone, status)
    values ('${branch}', '${tenant}', 'BRA', 'Branch A', 'UTC', 'active');
    insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type, status, is_fulfillment_enabled)
    values
      ('${locMain}', '${tenant}', '${branch}', 'LOC1', 'Loc 1', 'store', 'active', true),
      ('${locG}', '${tenant}', '${branch}', 'LOCG', 'Loc G', 'store', 'active', true),
      ('${locG2}', '${tenant}', '${branch}', 'LOCG2', 'Loc G2', 'store', 'active', true);
    select inventory_private.record_opening('${tenant}', '${variant}', '${locMain}', 1000);
    select inventory_private.record_opening('${tenant}', '${variant}', '${locG}', 100);
    select inventory_private.record_opening('${tenant}', '${variant}', '${locG2}', 100);
    `,
    "[seed] fixtures with high stock at every location",
  );
}

function createOrder(key, qty) {
  const orderId = scalar(
    `select orders_private.create_order('${tenant}','online','USD','${brand}',null,null,null,'${key}',null,null,` +
      `'[{"variant_id":"${variant}","product_id":"${product}","quantity":${qty},"unit_price_minor":1000,"product_name":"P","sku":"S"}]'::jsonb);`,
  );
  const orderLineId = scalar(
    `select id from public.order_lines where order_id='${orderId}' and variant_id='${variant}';`,
  );
  return { orderId, orderLineId };
}

function recordSql(orderId, loc, key, orderLineId, qty) {
  return (
    `begin; select * from fulfillments_private.record_fulfillment('${tenant}','${orderId}','${loc}',null,'${key}',null,` +
    `'[{"order_line_id":"${orderLineId}","quantity":${qty}}]'::jsonb);`
  );
}

function balanceAt(loc) {
  return Number(
    scalar(
      `select on_hand_quantity from public.inventory_balances where variant_id='${variant}' and inventory_location_id='${loc}';`,
    ),
  );
}

function fulfillmentCount(orderId) {
  return Number(scalar(`select count(*) from public.fulfillments where order_id='${orderId}';`));
}

function fulfilledQty(orderId) {
  return Number(
    scalar(
      `select coalesce(sum(fl.quantity),0) from public.fulfillment_lines fl where fl.order_id='${orderId}';`,
    ),
  );
}

async function run() {
  const s1 = new Session("s1");
  const s2 = new Session("s2");
  try {
    // ------------------------------------------------------------------ A: same key + intent
    {
      const { orderId, orderLineId } = createOrder("A-order", 5);
      await s1.run(recordSql(orderId, locMain, "A-key", orderLineId, 2));
      const marker = s2.dispatch(recordSql(orderId, locMain, "A-key", orderLineId, 2));
      await waitUntilBlocked("record_fulfillment");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("commit;");
      check(fulfillmentCount(orderId) === 1, "A: same key + intent yields exactly one fulfillment");
      check(
        Number(
          scalar(
            `select count(*) from public.fulfillments f join public.inventory_operations o on o.id=f.inventory_operation_id where f.order_id='${orderId}';`,
          ),
        ) === 1,
        "A: exactly one inventory operation is linked",
      );
      check(balanceAt(locMain) === 998, "A: stock issued exactly once (1000 -> 998)");
    }

    // ------------------------------------------------------------------ B: same key, different intent
    {
      const { orderId, orderLineId } = createOrder("B-order", 5);
      await s1.run(recordSql(orderId, locMain, "B-key", orderLineId, 2));
      const marker = s2.dispatch(recordSql(orderId, locMain, "B-key", orderLineId, 3));
      await waitUntilBlocked("record_fulfillment");
      s2.clearBuffer();
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("rollback;");
      check(
        fulfillmentCount(orderId) === 1,
        "B: same key different intent yields exactly one fulfillment",
      );
      check(fulfilledQty(orderId) === 2, "B: the winner's quantity (2) is the only one persisted");
    }

    // ------------------------------------------------------------------ C: over-fulfillment race
    {
      const before = balanceAt(locMain);
      const { orderId, orderLineId } = createOrder("C-order", 5);
      await s1.run(recordSql(orderId, locMain, "C-key-1", orderLineId, 4));
      const marker = s2.dispatch(recordSql(orderId, locMain, "C-key-2", orderLineId, 4));
      await waitUntilBlocked("record_fulfillment");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("rollback;");
      check(fulfillmentCount(orderId) === 1, "C: exactly one of the two qty-4 requests succeeds");
      check(fulfilledQty(orderId) === 4, "C: total fulfilled is 4, never 8");
      check(balanceAt(locMain) === before - 4, "C: exactly 4 pieces were issued");
    }

    // ------------------------------------------------------------------ D1: fulfill wins, cancel fails
    {
      const { orderId, orderLineId } = createOrder("D1-order", 5);
      await s1.run(recordSql(orderId, locMain, "D1-key", orderLineId, 1));
      const marker = s2.dispatch(
        `begin; select * from orders_private.cancel_order('${tenant}','${orderId}','${membership}','race');`,
      );
      await waitUntilBlocked("cancel_order");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("rollback;");
      check(fulfillmentCount(orderId) === 1, "D1: the fulfillment committed");
      check(
        scalar(`select status from public.orders where id='${orderId}';`) === "placed",
        "D1: the order remains placed (cancel lost and was refused)",
      );
    }

    // ------------------------------------------------------------------ D2: cancel wins, fulfill fails
    {
      const before = balanceAt(locMain);
      const { orderId, orderLineId } = createOrder("D2-order", 5);
      await s1.run(
        `begin; select * from orders_private.cancel_order('${tenant}','${orderId}','${membership}','win');`,
      );
      const marker = s2.dispatch(recordSql(orderId, locMain, "D2-key", orderLineId, 1));
      await waitUntilBlocked("record_fulfillment");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("rollback;");
      check(
        scalar(`select status from public.orders where id='${orderId}';`) === "cancelled",
        "D2: the order is cancelled (cancel won)",
      );
      check(fulfillmentCount(orderId) === 0, "D2: no fulfillment exists for the cancelled order");
      check(balanceAt(locMain) === before, "D2: no inventory was issued");
    }

    // ------------------------------------------------------------------ E: different orders, same location
    {
      const before = balanceAt(locMain);
      const a = createOrder("E-order-1", 5);
      const b = createOrder("E-order-2", 5);
      await s1.run(recordSql(a.orderId, locMain, "E-key-1", a.orderLineId, 1));
      const marker = s2.dispatch(recordSql(b.orderId, locMain, "E-key-2", b.orderLineId, 1));
      // s2 holds a different order lock but blocks on the shared location lifecycle lock.
      await waitUntilBlocked("record_fulfillment");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("commit;");
      check(
        fulfillmentCount(a.orderId) === 1 && fulfillmentCount(b.orderId) === 1,
        "E: both distinct-order fulfillments committed (no deadlock)",
      );
      check(balanceAt(locMain) === before - 2, "E: both issues applied exactly once");
    }

    // ------------------------------------------------------------------ F: fulfillment vs generic issue
    {
      const before = balanceAt(locMain);
      const { orderId, orderLineId } = createOrder("F-order", 5);
      await s1.run(recordSql(orderId, locMain, "F-key", orderLineId, 2));
      // A generic inventory issue on the SAME balance key blocks on the row lock, not an advisory lock.
      const marker = s2.dispatch(
        `begin; select inventory_private.record_operation('${tenant}','issue',` +
          `'[{"variant_id":"${variant}","inventory_location_id":"${locMain}","quantity_delta":-3}]'::jsonb,null,'F-issue',null,null);`,
      );
      await waitUntilBlocked("record_operation");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("commit;");
      check(
        balanceAt(locMain) === before - 5,
        "F: both the fulfillment (-2) and the generic issue (-3) applied",
      );
      check(fulfillmentCount(orderId) === 1, "F: the fulfillment committed exactly once");
    }

    // ------------------------------------------------------------------ G1: fulfill wins then deactivate; replay
    {
      const before = balanceAt(locG);
      const { orderId, orderLineId } = createOrder("G1-order", 5);
      await s1.run(recordSql(orderId, locG, "G1-key", orderLineId, 2));
      // Lock-abiding test-only lifecycle mutation: acquire the SAME advisory lock, then disable.
      const marker = s2.dispatch(
        `begin; select commerce_locks.acquire_inventory_location_lifecycle_lock('${tenant}','${locG}');` +
          `update public.inventory_locations set is_fulfillment_enabled=false where tenant_id='${tenant}' and id='${locG}';`,
      );
      await waitUntilBlocked("acquire_inventory_location_lifecycle_lock");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("commit;");
      check(
        fulfillmentCount(orderId) === 1,
        "G1: the fulfillment won and committed before deactivation",
      );
      check(
        scalar(
          `select is_fulfillment_enabled from public.inventory_locations where id='${locG}';`,
        ) === "f",
        "G1: the location is now fulfillment-disabled",
      );
      check(balanceAt(locG) === before - 2, "G1: exactly 2 pieces were issued");
      // Replay after deactivation returns the original fulfillment and never re-issues.
      await s1.run(recordSql(orderId, locG, "G1-key", orderLineId, 2));
      await s1.run("commit;");
      check(
        fulfillmentCount(orderId) === 1,
        "G1: replay after deactivation returns the original (still one fulfillment)",
      );
      check(
        balanceAt(locG) === before - 2,
        "G1: replay did not issue a second time despite the disabled location",
      );
    }

    // ------------------------------------------------------------------ G2: deactivate wins then fulfill fails
    {
      const before = balanceAt(locG2);
      const { orderId, orderLineId } = createOrder("G2-order", 5);
      await s1.run(
        `begin; select commerce_locks.acquire_inventory_location_lifecycle_lock('${tenant}','${locG2}');` +
          `update public.inventory_locations set status='inactive' where tenant_id='${tenant}' and id='${locG2}';`,
      );
      const marker = s2.dispatch(recordSql(orderId, locG2, "G2-key", orderLineId, 1));
      await waitUntilBlocked("record_fulfillment");
      await s1.run("commit;");
      await s2.waitForMarker(marker);
      await s2.run("rollback;");
      check(
        scalar(`select status from public.inventory_locations where id='${locG2}';`) === "inactive",
        "G2: the deactivation won",
      );
      check(
        fulfillmentCount(orderId) === 0,
        "G2: the fulfillment saw the inactive location and failed",
      );
      check(balanceAt(locG2) === before, "G2: no inventory was issued");
    }

    process.stdout.write(`\nAll ${passed} fulfillment concurrency assertions passed.\n`);
  } finally {
    await s1.close();
    await s2.close();
  }
}

runDocker(["version", "--format", "{{.Server.Version}}"]);
let containerStarted = false;
try {
  runDocker([
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
  waitForPostgres();
  runPsql(
    [
      "create role anon nologin noinherit;",
      "create role authenticated nologin noinherit;",
      "create role service_role nologin noinherit bypassrls;",
    ].join("\n"),
    "[setup] Supabase role fixtures",
  );
  applyMigrations();
  seedFixtures();
  await run();
} finally {
  if (containerStarted) {
    const cleanup = runDocker(["rm", "--force", containerName], { allowFailure: true });
    if (cleanup.status !== 0) {
      process.stderr.write(`Failed to remove PostgreSQL container ${containerName}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Removed PostgreSQL container ${containerName}\n`);
    }
  }
}
