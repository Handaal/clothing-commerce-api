// Phase 6B — FULL HTTP-SERVER-PATH offline-POS acceptance on an isolated disposable DB.
//
// Unlike `test-offline-pos-isolated.mjs` (which invokes route handlers in-process), this runner boots
// the REAL Next.js API server as a separate loopback process and drives it over HTTP through the packed
// SDK client. It proves the cases the in-process suite could not: real commit-then-lost-response over
// the wire, installment + balance-reducing payment ingestion, non-cash tender semantics, schema-version
// rejection, and (best-effort) concurrent-device stock behaviour.
//
// ISOLATION: reuses the PROVEN Phase 2M ownership boundary (`returns-test-resources.mjs`) exactly like
// the returns integration runner — unique `rt-<32hex>` project, disposable workdir, `--workdir`-pinned
// CLI, fresh-project migrations (NO reset), fail-closed config bind, label-scoped cleanup. It never
// calls `supabase stop`, never prunes, and never touches the shared dev project.
//
// AUTH: the server verifies Clerk RS256 JWTs using CLERK_JWT_KEY (the repo's existing local-test-key
// path, identical to the returns runner). This is standard configuration, NOT a verifier override or a
// production bypass: production sets CLERK_JWT_KEY to the real Clerk key. No production auth is weakened.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, scryptSync, sign } from "node:crypto";
import { readFileSync, cpSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResources, handleInterrupts } from "./returns-test-resources.mjs";
import {
  assertIsolatedSupabaseArgs,
  assertLoopbackDbHost,
  assertNotSharedProject,
  sanitizedChildEnv,
  assertIsolatedDbContainer,
} from "./supabase-isolation-guard.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules/supabase/dist/supabase.js");
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const resources = createResources();
const isolated = resources.workdir;
const projectId = resources.projectId;
// Fail closed before any CLI/Docker call if the minted id is not a disposable rt-<hex> project.
assertNotSharedProject(projectId);
const dbContainer = assertIsolatedDbContainer("supabase_db_" + projectId);
// Lowest-resource FAITHFUL backend for the attendance/offline HTTP path: db + gotrue + kong + postgrest.
// Everything heavy and unused by any offline route or the acceptance assertions is excluded (analytics/
// logflare, vector, realtime, storage, studio, imgproxy, mailpit, postgres-meta, edge-runtime, supavisor).
// gotrue is intentionally KEPT: `supabase status` only emits SERVICE_ROLE_KEY/ANON_KEY when auth is in the
// stack, and the test (PostgREST RLS) + server (supabase-js) need those static JWTs. Container memory is not
// the constraint here (~5 GB free on this host); the prior "4th stack" failure was the attendance migration
// failing to apply, not resource exhaustion.
const excluded =
  "realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const ports = new Set();
while (ports.size < 3) ports.add(await freePort());
const [apiPort, dbPort, nextPort] = [...ports];

mkdirSync(join(isolated, "supabase"));
cpSync(join(root, "supabase/migrations"), join(isolated, "supabase/migrations"), {
  recursive: true,
});
cpSync(join(root, "supabase/tests"), join(isolated, "supabase/tests"), { recursive: true });
const config = readFileSync(join(root, "supabase/config.toml"), "utf8")
  .replace('project_id = "clothing-commerce-api"', `project_id = "${projectId}"`)
  .replace("port = 54322", `port = ${dbPort}`)
  .replace("[api]", `[api]\nport = ${apiPort}`);
writeFileSync(join(isolated, "supabase/config.toml"), config);
resources.bindConfig(config); // fails closed if the project_id swap did not take
for (const name of [
  "app",
  "src",
  "packages",
  "package.json",
  "tsconfig.json",
  "next-env.d.ts",
  "next.config.ts",
])
  cpSync(join(root, name), join(isolated, name), { recursive: true });
symlinkSync(
  join(root, "node_modules"),
  join(isolated, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);

// Drop any line that could carry a key / token / connection string, so `redacted` output stays safe to
// print while still surfacing the actual error (e.g. a failing migration) instead of a blind "[redacted]".
function secretFilter(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/(key|secret|token|jwt|password|postgres(ql)?:\/\/|anon|service_role|eyJ)/i.test(line),
    )
    .join("\n");
}
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: isolated,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (r.status !== 0) {
    const raw = [r.stdout, r.stderr].filter(Boolean).join("\n");
    throw new Error(
      `isolated command failed: ${command} ${args.join(" ")} (${r.status})\n` +
        (options.redacted ? secretFilter(raw).slice(-4000) : raw),
    );
  }
  return r;
}
// Every Supabase CLI call goes through here so the static isolation guard runs first.
function supa(args, options = {}) {
  assertIsolatedSupabaseArgs(args, { repoRoot: root });
  return run(process.execPath, [supabase, ...args], options);
}
function sql(source) {
  return run(
    "docker",
    [
      "exec",
      "-i",
      dbContainer,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
    ],
    { input: source, stdio: ["pipe", "inherit", "inherit"] },
  );
}

let server;
function cleanup() {
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") {
      const killed = spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      if (killed.status !== 0)
        throw new Error("Could not stop owned Next.js process; cleanup aborted");
    } else process.kill(-server.pid, "SIGTERM");
  }
  resources.cleanup();
}
const removeInterruptHandlers = handleInterrupts(cleanup);
try {
  resources.assertOwner();
  run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"], { stdio: "inherit" });
  process.stdout.write(`Isolated project: ${projectId}; Next API on 127.0.0.1:${nextPort}\n`);
  supa(["start", "--workdir", isolated, "--exclude", excluded], { redacted: true });
  resources.plan();
  for (const name of ["phase_2h_pos_sale.setup.sql", "phase_2i_offline_pos.setup.sql"])
    sql(readFileSync(join(root, "supabase/tests", name), "utf8"));
  // The team-attendance case uses a POS operator with an explicit tenant-wide management grant.
  sql(
    "insert into public.role_permissions(tenant_id,role_id,permission_id) " +
      "select '2a000001-0000-4000-8000-000000000001'::uuid," +
      "'2a000013-0000-4000-8000-000000000001'::uuid,id from public.permissions " +
      "where key in ('attendance.manage','attendance.read','staff.read') on conflict do nothing;",
  );
  // Raise ONLY this isolated run's offline policy headroom for REGISTER so the HTTP tender/installment
  // regression matrix can execute several sales on one grant. This is a per-run fixture tweak on the
  // disposable DB (supabase_admin) — it does not touch the shared seed, the in-process suite's 3/10000
  // boundary assertions, or any production policy. The commercial limit *logic* is unchanged.
  sql(
    "update public.offline_pos_policies set max_pending_offline_sales = 50, " +
      "max_cumulative_exposure_minor = 100000000, max_offline_credit_exposure_minor = 100000000, " +
      "max_sale_amount_minor = 100000000, max_quantity_per_line = 1000 " +
      "where tenant_id = '2a000001-0000-4000-8000-000000000001';",
  );
  // Opt this isolated tenant into returns so the offline-return (Phase 5) acceptance matrix can issue return
  // grants and ingest returns. Per-run fixture on the disposable DB (supabase_admin) — no window / any reason /
  // manual settlement allowed; the offline path still only ever creates PENDING (withheld) refunds. Does not
  // touch the shared seed or any production policy; no live tenant is implicitly opted in by the migration.
  // ADR-042 D-7: offline return grants now require an owner refund budget. A large test-only budget keeps
  // the matrix about eligibility; the budget behaviour itself is proven in phase_3e.
  sql(
    "insert into public.return_settings(tenant_id, enabled, window_days, allowed_reasons, " +
      "manual_refunds_enabled, max_manual_refund_minor, offline_refund_budget_minor) values " +
      "('2a000001-0000-4000-8000-000000000001', true, null, null, true, null, 100000000) " +
      "on conflict (tenant_id) do update set enabled = true, manual_refunds_enabled = true, " +
      "offline_refund_budget_minor = 100000000;",
  );
  // ADR-042 §9: registers can no longer opt into any generic intent kind (constraint). The suite proves a
  // received one is rejected out of scope with no effect.
  // A separate never-stocked fixture product/variant so the adjudication matrix can prove the
  // no-oversell conflict (on-hand 0) and a count against a known canonical version.
  sql(
    "insert into public.products (id, tenant_id, brand_id, name, slug, status) values " +
      "('2a000006-0000-4000-8000-0000000000a1','2a000001-0000-4000-8000-000000000001'," +
      "'2a000002-0000-4000-8000-000000000001','Intent Fixture Tee','intent-fixture-tee','active');" +
      "insert into public.product_variants (id, tenant_id, product_id, sku, status) values " +
      "('2a000007-0000-4000-8000-0000000000a1','2a000001-0000-4000-8000-000000000001'," +
      "'2a000006-0000-4000-8000-0000000000a1','POS-TEE-ADJ','active');",
  );
  // Read-only OBSERVATION grant on the disposable DB so the intent matrix can prove that an offline supplier
  // payment intent creates NO supplier payment (case I9). supplier_payments is otherwise service-role
  // invisible; this grants SELECT only, on this run's throwaway database, and changes no product privilege.
  sql("grant select on public.supplier_payments to service_role;");
  // Give this isolated run ample on-hand headroom so the many returnable cash sales the offline-return matrix
  // creates all synchronize (fulfill) rather than depleting the seed's 10-unit opening stock and reconciling.
  // Added through the SANCTIONED ledger path (inventory_private.record_operation 'receipt', null actor — the
  // same shape the seed's deplete helper uses), not a direct balance write (which the guard trigger forbids).
  // Not for the multi-device suite: its no-oversell case sizes a sale against the seed's small stock.
  if (!process.argv.includes("tests/offline-pos-multidevice"))
    sql(
      "select inventory_private.record_operation(" +
        "'2a000001-0000-4000-8000-000000000001','receipt'," +
        "jsonb_build_array(jsonb_build_object('variant_id','2a000007-0000-4000-8000-000000000001'," +
        "'inventory_location_id','2a000004-0000-4000-8000-000000000001','quantity_delta',100000))," +
        "null,'http-return-stock-topup',null);",
    );

  // The cross-repo POS-client returns suite also drives the CONNECTED return + settlement path (a concurrent
  // connected return for the drift case, and post-sync refund settlement). Grant exactly the permissions the
  // returns fixture (phase_2m_returns.setup.sql) grants, to the same seeded role, ONLY for that suite's own
  // disposable DB — the default offline matrix keeps its unchanged fixture.
  if (process.argv.includes("tests/pos-client-returns-http"))
    sql(
      "insert into public.role_permissions(tenant_id,role_id,permission_id) " +
        "select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id " +
        "from public.permissions where key in ('returns.create','returns.read','payments.refund') " +
        "on conflict do nothing;",
    );

  // Online-order operations suite (staff fulfil / cancel of Storefront orders), on THIS run's disposable DB only:
  // the existing online-commerce fixture (COD checkout settings + published POS Tee) and orders.cancel for the
  // seeded POS Full role (it already holds orders.fulfill + inventory.issue tenant-wide).
  if (process.argv.includes("tests/online-order-operations-http")) {
    sql(readFileSync(join(root, "supabase/tests/phase_2l_online.setup.sql"), "utf8"));
    sql(
      "insert into public.role_permissions(tenant_id,role_id,permission_id) " +
        "select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id " +
        "from public.permissions where key = 'orders.cancel' on conflict do nothing;",
    );
  }

  // Offline PIN v2 suite: enrollment requires a server-verified step-up with the caller's OWN online POS
  // credential, so pos.full (test-only online PIN "4821") and pos.nopay (test-only "6390", a DIFFERENT account
  // used to prove a foreign credential is refused) get pos_pin accounts on THIS run's disposable DB only.
  if (process.argv.includes("tests/pos-client-pin-v2-http")) {
    const account = (membership, identity, subject, pin) => {
      const salt = randomBytes(16);
      const hash = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      return (
        "insert into public.user_identity_provider_bindings(user_identity_id, provider, provider_subject) values " +
        `('${identity}','pos_pin','${subject}');` +
        "insert into public.staff_pos_pin_credentials(tenant_id, membership_id, salt_base64, hash_base64, " +
        "scrypt_n, scrypt_r, scrypt_p, key_length, pos_role, pos_permissions, set_by_membership_id) values " +
        `('2a000001-0000-4000-8000-000000000001','${membership}','${salt.toString("base64")}',` +
        `'${hash.toString("base64")}',16384,8,1,32,'cashier','{}','2a000012-0000-4000-8000-000000000001');`
      );
    };
    sql(
      account(
        "2a000012-0000-4000-8000-000000000001",
        "2a000010-0000-4000-8000-000000000001",
        "pos-pin-acceptance-full",
        "4821",
      ) +
        account(
          "2a000012-0000-4000-8000-000000000002",
          "2a000010-0000-4000-8000-000000000002",
          "pos-pin-acceptance-nopay",
          "6390",
        ),
    );
  }

  // ADR-043 POS-native account suite (tests/pos-client-auth-http), on THIS run's disposable DB only: POS Full gets
  // tenant-wide staff.manage so it can act as the POS admin; three pos_pin accounts with TEST-ONLY PINs — pos.full
  // (admin, "4821"), pos.nopay (cashier, "6390") and pos.wrongloc (cashier, a 40-digit PIN longer than any retired
  // cap). Nothing here touches a shared DB.
  if (process.argv.includes("tests/pos-client-auth-http")) {
    const account = (membership, identity, subject, pin, role) => {
      const salt = randomBytes(16);
      const hash = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      return (
        "insert into public.user_identity_provider_bindings(user_identity_id, provider, provider_subject) values " +
        `('${identity}','pos_pin','${subject}');` +
        "insert into public.staff_pos_pin_credentials(tenant_id, membership_id, salt_base64, hash_base64, " +
        "scrypt_n, scrypt_r, scrypt_p, key_length, pos_role, pos_permissions, set_by_membership_id) values " +
        `('2a000001-0000-4000-8000-000000000001','${membership}','${salt.toString("base64")}',` +
        `'${hash.toString("base64")}',16384,8,1,32,'${role}','{}','2a000012-0000-4000-8000-000000000001');`
      );
    };
    sql(
      "insert into public.role_permissions(tenant_id,role_id,permission_id) " +
        "select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id " +
        "from public.permissions where key in ('staff.manage','staff.read') on conflict do nothing;" +
        account(
          "2a000012-0000-4000-8000-000000000001",
          "2a000010-0000-4000-8000-000000000001",
          "pos-auth-full",
          "4821",
          "admin",
        ) +
        account(
          "2a000012-0000-4000-8000-000000000002",
          "2a000010-0000-4000-8000-000000000002",
          "pos-auth-nopay",
          "6390",
          "cashier",
        ) +
        account(
          "2a000012-0000-4000-8000-000000000004",
          "2a000010-0000-4000-8000-000000000004",
          "pos-auth-wrongloc",
          "1357924680".repeat(4),
          "cashier",
        ),
    );
  }

  // ADR-042 cross-repo suite (offline new customer -> installment; admin credentials at the till). Only for that
  // suite's own disposable DB: the till operator may refund/redeem with admin credentials, offline returns
  // require them, and pos.full gets a pos_pin account (test-only PIN "4821", scrypt online verifier) so the
  // real PUT /pos/override-password re-authentication can run. Nothing here touches a shared DB.
  if (process.argv.includes("tests/pos-client-adr042-http")) {
    const pinSalt = randomBytes(16);
    const pinHash = scryptSync("4821", pinSalt, 32, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    sql(
      "insert into public.role_permissions(tenant_id,role_id,permission_id) " +
        "select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id " +
        "from public.permissions where key in ('returns.create','returns.read','payments.refund','promotions.manage') " +
        "on conflict do nothing;" +
        "update public.return_settings set offline_requires_admin_credentials = true " +
        "where tenant_id = '2a000001-0000-4000-8000-000000000001';" +
        "insert into public.user_identity_provider_bindings(user_identity_id, provider, provider_subject) values " +
        "('2a000010-0000-4000-8000-000000000001','pos_pin','pos-pin-acceptance-full');" +
        "insert into public.staff_pos_pin_credentials(tenant_id, membership_id, salt_base64, hash_base64, " +
        "scrypt_n, scrypt_r, scrypt_p, key_length, pos_role, pos_permissions, set_by_membership_id) values " +
        `('2a000001-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001','${pinSalt.toString("base64")}',` +
        `'${pinHash.toString("base64")}',16384,8,1,32,'admin','{}','2a000012-0000-4000-8000-000000000001');`,
    );
    // Stock channels + a voucher for the S-series. TEST-ONLY values on this disposable DB: an explicit split
    // (website 5 / POS 40 / rest unallocated) and, so the real HTTP + till path can be exercised end to end,
    // the deployment-wide enforcement gate is unlocked HERE ONLY (production unlock needs a reviewed
    // migration). The voucher has no channel policy yet; the suite sets it (with test-only caps) via the API.
    sql(
      "insert into public.promotions (id, tenant_id, name, benefit_type, benefit_percent_bp, target_type, activation_type, status) " +
        "values ('3e000001-0000-4000-8000-000000000001','2a000001-0000-4000-8000-000000000001','Ten off','percentage',1000,'order','code','active');" +
        "insert into public.promotion_codes (id, tenant_id, promotion_id, code) values " +
        "('3e000002-0000-4000-8000-000000000001','2a000001-0000-4000-8000-000000000001','3e000001-0000-4000-8000-000000000001','SAVE10');" +
        "select inventory_private.initialize_channel_stock('2a000001-0000-4000-8000-000000000001'," +
        "'2a000004-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001');" +
        "select inventory_private.allocate_channel_stock('2a000001-0000-4000-8000-000000000001'," +
        "'2a000004-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001','acceptance split','acc-split-1'," +
        "(select jsonb_agg(jsonb_build_object('variantId', b.variant_id," +
        "'websiteQuantity', case when b.variant_id = '2a000007-0000-4000-8000-000000000001' then 5 else 0 end," +
        "'posQuantity', case when b.variant_id = '2a000007-0000-4000-8000-000000000001' then 40 else 0 end," +
        "'expectedBalanceVersion', b.version)) from public.inventory_balances b " +
        "where b.inventory_location_id = '2a000004-0000-4000-8000-000000000001' and b.on_hand_quantity > 0));" +
        "update inventory_private.channel_feature_gate set enforcement_unlocked = true;" +
        "select inventory_private.set_channel_stock_mode('2a000001-0000-4000-8000-000000000001'," +
        "'2a000004-0000-4000-8000-000000000001','enforced','2a000012-0000-4000-8000-000000000001','acceptance');" +
        // Read-only OBSERVATION grants for the suite's assertions, on this throwaway DB only.
        "grant select on public.inventory_channel_balances, public.offline_pos_stock_grants, " +
        "public.offline_pos_stock_grant_lines, public.promotion_channel_policies, public.promotion_redemptions, " +
        "public.offline_voucher_exceptions, public.staff_pos_override_credentials to service_role;",
    );
  }

  // ADR-042 §13.6 cached-policy offline vouchers + Website checkout (one shared voucher limit). ONLY this
  // suite's disposable DB: the Website (storefront COD) fixture, promotions.manage for the till operator, test
  // vouchers (SAVE10 has a SHARED code limit of 3; the others are unlimited), and read-only OBSERVATION grants
  // for the assertions. Channel policies are set by the suite through the real API.
  if (process.argv.includes("tests/pos-client-vouchers-http")) {
    sql(readFileSync(join(root, "supabase/tests", "phase_2l_online.setup.sql"), "utf8"));
    const T = "'2a000001-0000-4000-8000-000000000001'";
    const promo = (n, name, type, value, code, max) =>
      `insert into public.promotions (id, tenant_id, name, benefit_type, ${type === "percentage" ? "benefit_percent_bp" : "benefit_amount_minor, benefit_currency"}, target_type, activation_type, status) values ` +
      `('3f000001-0000-4000-8000-00000000000${n}',${T},'${name}','${type}',${type === "percentage" ? value : `${value},'USD'`},'order','code','active');` +
      `insert into public.promotion_codes (id, tenant_id, promotion_id, code, max_redemptions) values ` +
      `('3f000002-0000-4000-8000-00000000000${n}',${T},'3f000001-0000-4000-8000-00000000000${n}','${code}',${max});`;
    sql(
      "insert into public.role_permissions(tenant_id,role_id,permission_id) " +
        `select ${T}::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id ` +
        "from public.permissions where key in ('promotions.manage','promotions.read') on conflict do nothing;" +
        promo(1, "Ten off", "percentage", 1000, "SAVE10", 3) +
        promo(2, "Five off", "fixed_amount", 500, "TAKE5", "null") +
        promo(3, "Policy change", "percentage", 500, "POLICY5", "null") +
        promo(4, "Revoke me", "percentage", 500, "REVOKE5", "null") +
        promo(5, "Expire me", "percentage", 500, "EXPIRE5", "null") +
        promo(6, "Admin only", "percentage", 500, "ADMINONLY", "null") +
        "grant select on public.promotion_redemptions, public.offline_voucher_exceptions, " +
        "public.offline_voucher_policy_issuances, public.promotion_channel_policies, public.order_adjustments, " +
        "public.promotions, public.promotion_codes to service_role;",
    );
  }

  // Emergency offline stock-shortfall acceptance (owner's final stock model: ONE shared pool). ONLY this suite's
  // disposable DB: the Website COD storefront fixture, a FRESH isolated product/variant with canonical stock 2
  // (posted through the sanctioned ledger receipt, no direct balance write), published for the Website, and
  // read-only OBSERVATION grants for the final SQL assertions.
  if (process.argv.includes("tests/pos-client-shortfall-http")) {
    sql(readFileSync(join(root, "supabase/tests", "phase_2l_online.setup.sql"), "utf8"));
    sql(
      "insert into public.products (id, tenant_id, brand_id, name, slug, status) values " +
        "('2a000006-0000-4000-8000-0000000000b1','2a000001-0000-4000-8000-000000000001'," +
        "'2a000002-0000-4000-8000-000000000001','Shortfall Tee','shortfall-tee','active');" +
        "insert into public.product_variants (id, tenant_id, product_id, sku, status) values " +
        "('2a000007-0000-4000-8000-0000000000b1','2a000001-0000-4000-8000-000000000001'," +
        "'2a000006-0000-4000-8000-0000000000b1','SHORT-TEE','active');" +
        "insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor, status) values " +
        "('2a000008-0000-4000-8000-0000000000b1','2a000001-0000-4000-8000-000000000001'," +
        "'2a000007-0000-4000-8000-0000000000b1','USD',2500,'active');" +
        "select inventory_private.record_operation('2a000001-0000-4000-8000-000000000001','receipt'," +
        "jsonb_build_array(jsonb_build_object('variant_id','2a000007-0000-4000-8000-0000000000b1'," +
        "'inventory_location_id','2a000004-0000-4000-8000-000000000001','quantity_delta',2))," +
        "null,'shortfall-opening-stock',null);" +
        "set role service_role; select * from catalog_private.publish_product('2a000001-0000-4000-8000-000000000001'," +
        "'2a000006-0000-4000-8000-0000000000b1','shortfall-publish'); reset role;" +
        "grant select on public.stock_reservations, public.checkout_operations, public.inventory_movements, " +
        "public.offline_reconciliations, public.inventory_channel_balances, public.offline_pos_stock_grants, " +
        "public.inventory_locations, public.fulfillments to service_role;",
    );
  }

  // Offline PIN v2 (and the shortfall suite's flag-off check): read-only OBSERVATION grants on this throwaway
  // DB only.
  if (
    process.argv.includes("tests/pos-client-pin-v2-http") ||
    process.argv.includes("tests/pos-client-shortfall-http")
  )
    sql(
      "grant select on public.staff_offline_pin_enrollments, public.staff_offline_pin_credentials to service_role;",
    );

  const status = JSON.parse(
    supa(["status", "--workdir", isolated, "--output", "json"], { redacted: true }).stdout,
  );
  const supaUrl = new URL(status.API_URL);
  // Verify the resolved DB/API host is loopback and on this run's allocated port before any write.
  assertLoopbackDbHost(supaUrl.hostname, "isolated Supabase API");
  if (supaUrl.port !== String(apiPort))
    throw new Error("Isolated Supabase returned unexpected API routing");

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const baseUrl = `http://127.0.0.1:${nextPort}`;
  const now = Math.floor(Date.now() / 1000);
  const part = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const issueToken = (subject) => {
    const content =
      part({ alg: "RS256", typ: "JWT", kid: "local-acceptance" }) +
      "." +
      part({
        sub: subject,
        sid: "sess_" + subject,
        iss: "https://clerk.local.test",
        azp: baseUrl,
        iat: now,
        nbf: now - 5,
        exp: now + 3600,
      });
    return (
      content + "." + sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")
    );
  };
  // Strip inherited .env / SUPABASE_* / POS_TEST_* / PG* / connection-string vars, then set exactly the
  // isolated server configuration so the real Next.js API can only reach THIS run's disposable database.
  const serverEnv = sanitizedChildEnv({
    SUPABASE_URL: status.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.local.test$").toString("base64")}`,
    CLERK_SECRET_KEY: "sk_test_local_acceptance_only",
    CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    CLERK_AUTHORIZED_PARTIES: baseUrl,
    // The retired OFFLINE_PIN_KEK is deliberately NOT provided: nothing reads it (offline PIN v2), and the
    // suites prove the server works without it. sanitizedChildEnv drops any inherited value.
    OFFLINE_PIN_KEK: undefined,
    OFFLINE_PIN_KEK_VERSION: undefined,
    // Offline PIN v2: default OFF everywhere; enabled ONLY on this run's disposable loopback server for the
    // PIN v2 suite. Every other suite runs with it off (enrollment refused, no unlock authorizations).
    POS_OFFLINE_PIN_V2: process.argv.includes("tests/pos-client-pin-v2-http")
      ? "enabled"
      : undefined,
    // ADR-042 §13.6: default OFF everywhere; enabled ONLY on this run's disposable loopback server for the
    // cached-voucher suite (an inherited value is removed for every other suite).
    // ADR-043: the POS-native sign-in provider is dormant without a signing key; the account suite gets a fresh
    // random one for THIS run's loopback server only (never printed, never persisted).
    POS_AUTH_SIGNING_KEY: process.argv.includes("tests/pos-client-auth-http")
      ? randomBytes(32).toString("base64")
      : undefined,
    POS_OFFLINE_CACHED_VOUCHERS: process.argv.includes("tests/pos-client-vouchers-http")
      ? "enabled"
      : undefined,
    NEXT_TELEMETRY_DISABLED: "1",
  });
  server = spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(nextPort),
    ],
    {
      cwd: isolated,
      env: serverEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostic = "";
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-40000);
    });
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (server.exitCode !== null) throw new Error(`API server exited: ${diagnostic}`);
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`API server did not start: ${diagnostic}`);
  process.stdout.write(
    "Real Next.js API + isolated Supabase ready; running HTTP acceptance over the SDK.\n",
  );

  // Which HTTP acceptance suite to run against this isolated server (default: the offline-sale/tender/
  // installment matrix). `--dir <path>` selects another suite (e.g. the multi-device suite) on its own
  // fresh isolated server, so suites never share a database or contend for the same location lock.
  const dirFlagIndex = process.argv.indexOf("--dir");
  const testDir =
    dirFlagIndex >= 0 ? process.argv[dirFlagIndex + 1] : "tests/offline-pos-http-integration";
  try {
    run(process.execPath, [vitest, "run", testDir, "--testTimeout=60000", "--hookTimeout=60000"], {
      cwd: root,
      stdio: "inherit",
      env: sanitizedChildEnv({
        POS_TEST_API_BASE_URL: baseUrl,
        POS_TEST_CLERK_TOKEN: issueToken("pos-full"),
        // A branch/location-scoped operator with no brand-wide order authority (negative cases).
        POS_TEST_CLERK_TOKEN_RESTRICTED: issueToken("pos-wrong-location"),
        POS_TEST_SUPABASE_URL: status.API_URL,
        POS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
        POS_TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
      }),
    });
  } catch (error) {
    // The vitest run above is a BLOCKING spawnSync, so the server's stdout/stderr 'data' events cannot
    // fire during it. Yield briefly so the queued pipe output (including the route's console.error with
    // the underlying SQL/stack) flushes before we print the tail. Server-generated only — never secrets.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.stderr.write(
      `\n----- API server log tail -----\n${diagnostic}\n----- end server log -----\n`,
    );
    throw error;
  }
  process.stdout.write("Isolated full-HTTP-path offline-POS acceptance passed.\n");
} finally {
  removeInterruptHandlers();
  cleanup();
}
