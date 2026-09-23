import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic two-session regression for the Phase 2P-A final-redemption guarantee against a
// disposable PostgreSQL instance. A single-use voucher (max_redemptions = 1) is raced by two genuinely
// concurrent transactions, each redeeming against its own already-committed Order:
//   * exactly one redemption succeeds; the other blocks on the promotion/code row lock and, once the
//     winner commits, fails with the canonical exhausted result (PR409);
//   * exactly one promotion_redemption row exists; promotion + code counters reconcile to 1;
//   * the loser leaves no adjustment/redemption state (its transaction rolls back cleanly);
//   * re-redeeming the already-adjusted winning Order does not consume again (double-consume guard).
// Coordination polls pg_stat_activity for a genuine lock wait, never fixed timing.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const containerName = `clothing-commerce-promotions-concurrency-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-promotions-concurrency-test-only";

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
const price = "40000000-0000-4000-8000-000000000001";
const promotion = "a0000000-0000-4000-8000-000000000001";
const code = "c1000000-0000-4000-8000-000000000001";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redeemSql(orderId) {
  return `select (promotions_private.redeem('${tenant}','${orderId}','ONCE')->>'applied');`;
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
      ["exec", containerName, "pg_isready", "--host", pgHost, "--port", pgPort, "--username", "postgres", "--dbname", databaseName],
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

function seedFixtures() {
  runPsql(
    `
    insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
    values ('${tenant}', 'promo-conc', 'Promo Concurrency', 'active', 'completed', 'USD');
    insert into public.brands (id, tenant_id, code, display_name)
    values ('${brand}', '${tenant}', 'A', 'Brand A');
    insert into public.products (id, tenant_id, brand_id, name, slug, status)
    values ('${product}', '${tenant}', '${brand}', 'P', 'p', 'active');
    insert into public.product_variants (id, tenant_id, product_id, sku, status)
    values ('${variant}', '${tenant}', '${product}', 'S', 'active');
    insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor)
    values ('${price}', '${tenant}', '${variant}', 'USD', 2000);
    insert into public.promotions (id, tenant_id, name, benefit_type, benefit_percent_bp, target_type, activation_type, status)
    values ('${promotion}', '${tenant}', 'Voucher', 'percentage', 1000, 'order', 'code', 'active');
    insert into public.promotion_codes (id, tenant_id, promotion_id, code, max_redemptions, status)
    values ('${code}', '${tenant}', '${promotion}', 'ONCE', 1, 'active');
    `,
    "[seed] tenant, catalog, single-use voucher (ONCE, max_redemptions = 1)",
  );
}

function createOrder(key) {
  return scalar(
    `select orders_private.create_order('${tenant}','online','USD','${brand}',null,null,null,'${key}',null,null,` +
      `'[{"variant_id":"${variant}","product_id":"${product}","quantity":1,"unit_price_minor":2000,"product_name":"P","sku":"S"}]'::jsonb);`,
  );
}

async function finalVoucherRace() {
  process.stdout.write("Scenario: two concurrent redemptions of the final voucher use\n");
  // Two already-committed, undiscounted orders so the ONLY contention is the redemption row lock.
  const orderA = createOrder("voucher-a");
  const orderB = createOrder("voucher-b");
  check(orderA !== orderB && orderA.length === 36, "two independent orders were created for the race");

  const s1 = new Session("v1");
  const s2 = new Session("v2");
  try {
    await s1.run("select 1;");
    await s2.run("select 1;");
    await s1.run("begin;");
    await s1.run(redeemSql(orderA));
    check(s1.bufferIncludes("true"), "the first redemption applies the voucher");
    await s2.run("begin;");
    const marker = s2.dispatch(redeemSql(orderB));
    await waitUntilBlocked("redeem");
    check(true, "the second concurrent redemption blocks on the promotion/code row lock");
    await s1.run("commit;");
    await s2.waitForMarker(marker);
    check(
      s2.bufferIncludes("no longer available"),
      "the redemption loser is rejected with the canonical exhausted result (PR409)",
    );
    await s2.run("rollback;");
  } finally {
    await s1.close();
    await s2.close();
  }

  check(
    scalar(`select count(*) from public.promotion_redemptions where tenant_id = '${tenant}';`) === "1",
    "exactly one promotion_redemption row exists",
  );
  check(
    scalar(`select redemption_count from public.promotion_codes where id = '${code}';`) === "1",
    "the voucher code redemption counter reconciles to 1",
  );
  check(
    scalar(`select redemption_count from public.promotions where id = '${promotion}';`) === "1",
    "the promotion redemption counter reconciles to 1",
  );
  check(
    scalar(`select count(*) from public.order_adjustments where order_id = '${orderA}';`) === "1",
    "the winning order carries exactly one immutable adjustment",
  );
  check(
    scalar(`select count(*) from public.order_adjustments where order_id = '${orderB}';`) === "0",
    "the losing order carries no adjustment (its transaction rolled back cleanly)",
  );
  check(
    scalar(`select discount_total_minor from public.orders where id = '${orderB}';`) === "0",
    "the losing order remains undiscounted",
  );

  // Double-consume guard: re-redeeming the already-adjusted winner does not consume again. The RAISE
  // aborts under ON_ERROR_STOP, so capture with allowFailure and inspect the combined output.
  process.stdout.write("[retry] re-redeem the already-adjusted winning order\n");
  const retry = runDocker(
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
    { input: `select promotions_private.redeem('${tenant}','${orderA}','ONCE');`, allowFailure: true },
  );
  check(
    `${retry.stdout}${retry.stderr}`.includes("already adjusted"),
    "re-redeeming the winning order is rejected and does not consume the voucher again",
  );
  check(
    scalar(`select redemption_count from public.promotion_codes where id = '${code}';`) === "1",
    "the voucher counter stays at 1 after the retry",
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

  await finalVoucherRace();

  process.stdout.write(`\nAll ${passed} Phase 2P promotion concurrency assertions passed.\n`);
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
