// ADR-042 channel stock pools — isolated persistence proof.
// Spins its own disposable postgres container (tmpfs, no published port, unique name), applies every
// migration on a fresh database, loads the POS + online fixtures, runs the channel test with real commits,
// and always removes the container. Never touches a shared/dev Supabase stack.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const testsDirectory = join(repositoryRoot, "supabase", "tests");
// Each suite runs in its own fresh database. Optional CLI filter: a substring of the suite name.
//
// ADR-042 §13 (owner decision 2026-11-14 night): the Website/POS stock split, per-till stock grants,
// reserved voucher quota and offline returns are SUPERSEDED. `20261115150000` pins every location to shared
// stock and revokes the issuing entry points, so the historical suites below can only run against the
// migration chain as it was before that decision (`uptoMigration`). They are kept as evidence of what the
// dormant structures do and are skipped unless `--include-superseded` is passed. The current-scope suite is
// "online-first sync conflicts".
const PRE_SUPERSEDE = "20261115120000_offline_sale_reconciliation_holds.sql";
const suites = [
  {
    // Storefront program Phase 1A: product options, swatches, categories and the public projection.
    name: "storefront options and categories",
    testFile: "phase_4a_catalog_options_categories_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2l_online.setup.sql"],
    marker: "ALL_CATALOG_OPTIONS_CATEGORIES_ASSERTIONS_PASSED",
  },
  {
    name: "online-first sync conflicts",
    testFile: "phase_3h_online_first_sync_conflicts_persistence.sql",
    fixtures: [
      "phase_2h_pos_sale.setup.sql",
      "phase_2i_offline_pos.setup.sql",
      "phase_2l_online.setup.sql",
    ],
    marker: "ALL_ONLINE_FIRST_SYNC_CONFLICT_ASSERTIONS_PASSED",
  },
  {
    name: "lease bounds and offline PIN v2",
    testFile: "phase_3j_lease_bounds_and_pin_v2_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    marker: "ALL_LEASE_BOUNDS_AND_PIN_V2_ASSERTIONS_PASSED",
  },
  {
    // ADR-043 §5.1: offline sales carry the operator who unlocked the till; verified at ingestion.
    name: "offline operator attribution",
    testFile: "phase_3m_offline_operator_attribution_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    marker: "ALL_OFFLINE_OPERATOR_ATTRIBUTION_ASSERTIONS_PASSED",
  },
  {
    // ADR-043: PIN reset revokes offline-PIN enrollments; last active POS admin protection.
    name: "POS-native account lifecycle",
    testFile: "phase_3l_pos_native_account_lifecycle_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    marker: "ALL_POS_NATIVE_ACCOUNT_LIFECYCLE_ASSERTIONS_PASSED",
  },
  {
    // The old-PIN cleanup migration on EXISTING rows: migrations before 20261115170000 → fixtures → seed live
    // v1 (KEK-sealed) rows → the remaining migrations → assertions. Reproduces the shared-dev situation on a
    // disposable database only; shared dev itself is never touched.
    name: "v1 PIN cleanup on existing rows",
    testFile: "phase_3k_v1_pin_cleanup_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    seedBefore: {
      migration: "20261115170000_offline_pin_device_enrollment.sql",
      file: "phase_3k_v1_pin_rows.seed.sql",
    },
    marker: "ALL_V1_PIN_CLEANUP_ASSERTIONS_PASSED",
  },
  {
    name: "inventory channel invariants + storefront read path",
    superseded: true,
    uptoMigration: PRE_SUPERSEDE,
    testFile: "phase_3a_inventory_channels_persistence.sql",
    fixtures: [
      "phase_2h_pos_sale.setup.sql",
      "phase_2l_online.setup.sql",
      "phase_2m_returns.setup.sql",
    ],
    marker: "ALL_INVENTORY_CHANNEL_ASSERTIONS_PASSED",
  },
  {
    name: "offline POS stock grants",
    superseded: true,
    uptoMigration: PRE_SUPERSEDE,
    testFile: "phase_3c_offline_stock_grants_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    marker: "ALL_OFFLINE_STOCK_GRANT_ASSERTIONS_PASSED",
  },
  {
    name: "offline vouchers + admin credentials",
    superseded: true,
    uptoMigration: PRE_SUPERSEDE,
    testFile: "phase_3d_offline_vouchers_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    marker: "ALL_OFFLINE_VOUCHER_ASSERTIONS_PASSED",
  },
  {
    name: "offline returns budget + credentials",
    superseded: true,
    uptoMigration: PRE_SUPERSEDE,
    testFile: "phase_3e_offline_returns_persistence.sql",
    fixtures: [
      "phase_2h_pos_sale.setup.sql",
      "phase_2i_offline_pos.setup.sql",
      "phase_2m_returns.setup.sql",
    ],
    marker: "ALL_OFFLINE_RETURN_ASSERTIONS_PASSED",
  },
  {
    name: "offline customers + retired intent scope",
    testFile: "phase_3f_offline_customers_scope_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    marker: "ALL_OFFLINE_CUSTOMER_SCOPE_ASSERTIONS_PASSED",
  },
  {
    name: "offline sale reconciliation holds",
    superseded: true,
    uptoMigration: PRE_SUPERSEDE,
    testFile: "phase_3g_offline_sale_holds_persistence.sql",
    fixtures: ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"],
    marker: "ALL_OFFLINE_SALE_HOLD_ASSERTIONS_PASSED",
  },
];
let containerName = "";
const postgresImage = "postgres:17.6-alpine";
const databaseName = "commerce_test";
const databasePassword = "local-inventory-channels-test-only";
const psqlConnectionArgs = [
  "--host",
  "127.0.0.1",
  "--port",
  "5432",
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
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  }
  return result;
}

function runPsql(sql, label, { echo = false } = {}) {
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
  if (echo) process.stdout.write(result.stdout);
  if (result.stderr && echo) process.stderr.write(result.stderr);
  return result;
}

function waitForPostgres() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = runDocker(
      [
        "exec",
        containerName,
        "pg_isready",
        ...psqlConnectionArgs.slice(0, 6),
        "--dbname",
        databaseName,
      ],
      { allowFailure: true },
    );
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error("PostgreSQL did not become ready within 60 seconds.");
}

function runSuite(suite) {
  // Unique disposable rt-<32hex> container with an ownership label; no published port, tmpfs data.
  containerName = `rt-${randomBytes(16).toString("hex")}`;
  let started = false;
  try {
    runDocker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      "clothing-commerce.test=inventory-channels",
      "--label",
      `clothing-commerce.owner=${containerName}`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "--env",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "--env",
      `POSTGRES_DB=${databaseName}`,
      postgresImage,
    ]);
    started = true;
    waitForPostgres();
    runPsql(
      "create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;",
      "[setup] Supabase role fixtures",
    );
    const migrations = readdirSync(migrationDirectory)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => !suite.uptoMigration || f <= suite.uptoMigration)
      .sort();
    const before = suite.seedBefore
      ? migrations.filter((f) => f < suite.seedBefore.migration)
      : migrations;
    const after = suite.seedBefore ? migrations.filter((f) => f >= suite.seedBefore.migration) : [];
    for (const migration of before)
      runPsql(readFileSync(join(migrationDirectory, migration), "utf8"), `[migrate] ${migration}`);
    for (const fixture of suite.fixtures)
      runPsql(readFileSync(join(testsDirectory, fixture), "utf8"), `[fixture] ${fixture}`);
    if (suite.seedBefore) {
      runPsql(
        readFileSync(join(testsDirectory, suite.seedBefore.file), "utf8"),
        `[seed] ${suite.seedBefore.file}`,
      );
      for (const migration of after)
        runPsql(
          readFileSync(join(migrationDirectory, migration), "utf8"),
          `[migrate] ${migration}`,
        );
    }
    const result = runPsql(
      readFileSync(join(testsDirectory, suite.testFile), "utf8"),
      `[test] ${suite.name}`,
      { echo: true },
    );
    if (!`${result.stdout}${result.stderr}`.includes(suite.marker)) {
      throw new Error(`Success marker ${suite.marker} not found.`);
    }
    process.stdout.write(`PASS ${suite.marker}
`);
  } finally {
    if (started) {
      runDocker(["rm", "--force", containerName], { allowFailure: true });
      process.stdout.write(`[cleanup] removed ${containerName}
`);
    }
  }
}

process.stdout.write(
  `Docker engine ${runDocker(["version", "--format", "{{.Server.Version}}"]).stdout.trim()}
`,
);
const includeSuperseded = process.argv.includes("--include-superseded");
const filter = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
for (const suite of suites.filter(
  (entry) => (!filter || entry.name.includes(filter)) && (includeSuperseded || !entry.superseded),
))
  runSuite(suite);
