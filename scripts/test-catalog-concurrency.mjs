import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic two-session regression for the tenant-scoped category cycle advisory lock.
// It proves three things against a real, disposable PostgreSQL instance:
//   1. Concurrent same-tenant reparents (X -> Y and Y -> X) can never both commit a cycle.
//   2. The blocked session genuinely waits on an advisory lock (observed via pg_locks),
//      rather than passing cycle detection against a stale snapshot.
//   3. A different tenant is not blocked by another tenant's held hierarchy lock.
// Coordination uses pg_locks polling and echo markers, never fixed timing, and every wait is
// bounded so the test cannot hang. A finally block removes only the container it created.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const containerName = `clothing-commerce-catalog-concurrency-${process.pid}`;
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-catalog-concurrency-test-only";

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "10000000-0000-4000-8000-000000000002";
// Tenant A holds two disjoint chains, node1 -> node2 and node3 -> node4 (child -> parent).
// The two concurrent reparents (node2 -> node3 and node4 -> node1) touch disjoint rows and
// disjoint foreign-key parents, so no row/FK lock conflict serializes them: only the tenant
// advisory lock can, which is exactly what this regression proves.
const nodeA1 = "c0000000-0000-4000-8000-000000000001";
const nodeA2 = "c0000000-0000-4000-8000-000000000002";
const nodeA3 = "c0000000-0000-4000-8000-000000000005";
const nodeA4 = "c0000000-0000-4000-8000-000000000006";
const nodeB1 = "c0000000-0000-4000-8000-000000000003";
const nodeB2 = "c0000000-0000-4000-8000-000000000004";

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

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.stdout;
}

function scalar(sql) {
  const result = runDocker([
    "exec",
    containerName,
    "psql",
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--username",
    "postgres",
    "--dbname",
    databaseName,
    "--command",
    sql,
  ]);

  return result.stdout.trim();
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
        containerName,
        "psql",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=0",
        "--username",
        "postgres",
        "--dbname",
        databaseName,
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

  // Writes a statement plus a unique echo marker. Returns the marker to await.
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

  async close() {
    try {
      this.proc.stdin.end();
    } catch {
      // The process may already be gone; cleanup is best effort.
    }
  }
}

function sessionsWaitingOnAdvisoryLock() {
  return Number(
    scalar(
      "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory';",
    ),
  );
}

function grantedAdvisoryLocks() {
  return Number(scalar("select count(*) from pg_locks where locktype = 'advisory' and granted;"));
}

// Polls (never sleeps a fixed interval) until the second session is observed genuinely
// waiting on the tenant advisory lock, so the coordination is deterministic, not timing based.
async function waitUntilBlocked(timeoutMs = 15000) {
  const start = Date.now();
  while (sessionsWaitingOnAdvisoryLock() < 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("second session never blocked on the tenant advisory lock");
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

async function runScenario() {
  runPsql(
    `
    insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
    values
      ('${tenantA}', 'concurrency-a', 'Concurrency A', 'active', 'completed', 'USD'),
      ('${tenantB}', 'concurrency-b', 'Concurrency B', 'active', 'completed', 'EUR');

    insert into public.categories (id, tenant_id, name, slug)
    values
      ('${nodeA2}', '${tenantA}', 'Node A2', 'node-a2'),
      ('${nodeA4}', '${tenantA}', 'Node A4', 'node-a4'),
      ('${nodeB2}', '${tenantB}', 'Node B2', 'node-b2');

    insert into public.categories (id, tenant_id, parent_category_id, name, slug)
    values
      ('${nodeA1}', '${tenantA}', '${nodeA2}', 'Node A1', 'node-a1'),
      ('${nodeA3}', '${tenantA}', '${nodeA4}', 'Node A3', 'node-a3'),
      ('${nodeB1}', '${tenantB}', '${nodeB2}', 'Node B1', 'node-b1');
    `,
    "[seed] tenant A chains node1->node2 and node3->node4; tenant B chain node1->node2",
  );

  const sessionOne = new Session("s1");
  const sessionTwo = new Session("s2");

  try {
    await sessionOne.run("select 1;");
    await sessionTwo.run("select 1;");
    await sessionTwo.run("set statement_timeout = '20s';");

    // T1 reparents node2 -> node3 and holds tenant A's advisory lock open (uncommitted).
    await sessionOne.run("begin;");
    await sessionOne.run(
      `update public.categories set parent_category_id = '${nodeA3}' where id = '${nodeA2}';`,
    );

    // Tenant B mutates its own hierarchy while tenant A's lock is held; it must not block.
    const beforeB = Date.now();
    runPsql(
      `set statement_timeout = '5s';
       update public.categories set parent_category_id = null where id = '${nodeB1}';`,
    );
    const tenantBParent = scalar(
      `select coalesce(parent_category_id::text, 'null') from public.categories where id = '${nodeB1}';`,
    );
    check(
      tenantBParent === "null" && Date.now() - beforeB < 5000,
      "a different tenant reparents without waiting on another tenant's hierarchy lock",
    );

    check(
      grantedAdvisoryLocks() === 1,
      "the first session holds exactly one tenant hierarchy advisory lock",
    );

    // T2 attempts node4 -> node1. Its rows and FK parent are disjoint from T1's, so only the
    // tenant advisory lock can serialize it; it must block, not race past cycle detection.
    const t2Marker = sessionTwo.dispatch(
      `update public.categories set parent_category_id = '${nodeA1}' where id = '${nodeA4}';`,
    );
    await waitUntilBlocked();
    check(true, "the second same-tenant reparent blocks on the tenant advisory lock");

    // Releasing T1 lets T2 re-check against a fresh snapshot; it must detect the cycle.
    await sessionOne.run("commit;");
    await sessionTwo.waitForMarker(t2Marker);
    await sessionTwo.run("rollback;");

    const parentNode2 = scalar(
      `select coalesce(parent_category_id::text, 'null') from public.categories where id = '${nodeA2}';`,
    );
    const parentNode4 = scalar(
      `select coalesce(parent_category_id::text, 'null') from public.categories where id = '${nodeA4}';`,
    );
    check(parentNode2 === nodeA3, "the first reparent (node2 -> node3) survives");
    check(parentNode4 === "null", "the conflicting reparent (node4 -> node1) did not commit");

    const cycleCount = scalar(`
      with recursive walk as (
        select id, parent_category_id, array[id] as path, false as cycle
        from public.categories
        where tenant_id = '${tenantA}'
        union all
        select node.id, node.parent_category_id, walk.path || node.id, node.id = any (walk.path)
        from public.categories as node
        join walk on node.id = walk.parent_category_id
        where node.tenant_id = '${tenantA}' and not walk.cycle
      )
      select count(*) from walk where cycle;
    `);
    check(cycleCount === "0", "the final tenant A hierarchy is acyclic");

    const keysDiffer = scalar(
      `select pg_catalog.hashtextextended('${tenantA}', 0) <> pg_catalog.hashtextextended('${tenantB}', 0);`,
    );
    check(keysDiffer === "t", "distinct tenants derive distinct advisory-lock keys");
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

  await runScenario();

  process.stdout.write(
    `Phase 2A category concurrency regression passed (${passed} deterministic checks).\n`,
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
