import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

// Real local-Postgres coverage for scripts/provision-dev-commerce-fixture.mjs. Run through
// `pnpm test:dev:commerce-fixture`, which starts and resets a disposable local Supabase stack and
// injects the connection env below. No shared or production project is supported.

const url = process.env.DEV_FIXTURE_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.DEV_FIXTURE_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "Run this suite through pnpm test:dev:commerce-fixture; it requires the disposable local Supabase stack.",
  );
}

const admin: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

const identityScript = join(process.cwd(), "scripts", "provision-dev-identity.mjs");
const fixtureScript = join(process.cwd(), "scripts", "provision-dev-commerce-fixture.mjs");

// Deterministic fixture identifiers (must match supabase/dev/provision-dev-commerce-fixture.sql).
const PRODUCT_ACTIVE_ID = "90000000-0000-4000-8000-000000000001";
const PRODUCT_DRAFT_ID = "90000000-0000-4000-8000-000000000002";
const VARIANT_M_ID = "71a71a00-0000-4000-8000-000000000001";
const VARIANT_L_ID = "71a71a00-0000-4000-8000-000000000002";
const VARIANT_TOTE_ID = "71a71a00-0000-4000-8000-000000000003";
const LOCATION_ID = "10ca7100-0000-4000-8000-000000000001";
const LOCATION_2_ID = "10ca7100-0000-4000-8000-000000000002";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function provisionIdentity(subject: string): RunResult {
  const result = spawnSync(process.execPath, [identityScript, "--clerk-subject", subject], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, COMMERCE_DEV_PROVISIONING: "1" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function provisionFixture(): RunResult {
  const result = spawnSync(process.execPath, [fixtureScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, COMMERCE_DEV_FIXTURES: "1" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function devTenantId(): Promise<string | null> {
  const { data } = await admin.from("tenants").select("id").eq("slug", "dev-local").maybeSingle();
  return data ? data.id : null;
}

async function countProducts(tenantId: string): Promise<number> {
  const { count } = await admin
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  return count ?? 0;
}

describe("development commerce fixture (local Postgres)", () => {
  beforeAll(() => {
    expect(fixtureScript).toContain("provision-dev-commerce-fixture.mjs");
  });

  it("(missing dev-local) fails clearly and seeds nothing", async () => {
    // The disposable DB starts without dev-local, so the precondition guard must fire.
    expect(await devTenantId()).toBeNull();

    const result = provisionFixture();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/dev-local not found/i);

    const { count: brandCount } = await admin
      .from("brands")
      .select("id", { count: "exact", head: true });
    expect(brandCount).toBe(0);
  });

  it("provisions the dev identity as a precondition (creates dev-local)", () => {
    const result = provisionIdentity("user_dev_fixture");
    expect(result.status).toBe(0);
  });

  it("(rollback) a mid-graph failure leaves no partial fixture data", async () => {
    const tenantId = await devTenantId();
    expect(tenantId).not.toBeNull();

    // Pre-create the fixture's branch + location, but with the location fulfillment-DISABLED. The
    // fixture reuses them (ON CONFLICT on the natural code), so its final step (record_fulfillment)
    // fails with FF022 AFTER the brand/products/order have been inserted in the same transaction.
    const { error: branchError } = await admin.from("branches").insert({
      tenant_id: tenantId,
      code: "DEV-BRANCH",
      display_name: "Pre Branch",
      timezone: "UTC",
      status: "active",
    });
    expect(branchError).toBeNull();
    const { data: branch } = await admin
      .from("branches")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("normalized_code", "dev-branch")
      .single();
    const { error: locationError } = await admin.from("inventory_locations").insert({
      tenant_id: tenantId,
      branch_id: branch?.id,
      code: "DEV-LOC-1",
      display_name: "Pre Location",
      location_type: "stockroom",
      status: "active",
      is_sellable: true,
      is_fulfillment_enabled: false,
    });
    expect(locationError).toBeNull();

    const result = provisionFixture();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/fulfillment-enabled|FF022/i);

    // Atomicity: the brand/products/order created earlier in the same transaction were rolled back.
    expect(await countProducts(tenantId as string)).toBe(0);
    const { count: orderCount } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    expect(orderCount).toBe(0);

    // Remove the misconfigured location + branch so the success run seeds a clean, enabled graph.
    await admin
      .from("inventory_locations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", LOCATION_ID);
    await admin
      .from("inventory_locations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("normalized_code", "dev-loc-1");
    await admin
      .from("branches")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("normalized_code", "dev-branch");
  });

  it("(first run) seeds the full deterministic commerce graph", async () => {
    const tenantId = (await devTenantId()) as string;

    const result = provisionFixture();
    expect(result.status).toBe(0);

    // Products: exactly two, active + draft, at the deterministic ids (list + status rendering).
    const { data: products } = await admin
      .from("products")
      .select("id,status,style_code,brand_id")
      .eq("tenant_id", tenantId)
      .order("status", { ascending: true });
    expect(products?.map((p) => p.id).sort()).toEqual([PRODUCT_ACTIVE_ID, PRODUCT_DRAFT_ID].sort());
    const active = products?.find((p) => p.id === PRODUCT_ACTIVE_ID);
    const draft = products?.find((p) => p.id === PRODUCT_DRAFT_ID);
    expect(active?.status).toBe("active");
    expect(draft?.status).toBe("draft");
    expect(active?.style_code).toBe("DEV-LS-001");

    // Detail-relevant: variants, options, values, prices for the active product.
    const { data: variants } = await admin
      .from("product_variants")
      .select("id,status")
      .eq("tenant_id", tenantId)
      .eq("product_id", PRODUCT_ACTIVE_ID);
    expect(variants?.map((v) => v.id).sort()).toEqual([VARIANT_M_ID, VARIANT_L_ID].sort());

    const { data: options } = await admin
      .from("product_options")
      .select("id,name")
      .eq("tenant_id", tenantId)
      .eq("product_id", PRODUCT_ACTIVE_ID);
    expect(options).toHaveLength(1);
    expect(options?.[0].name).toBe("Size");

    const { count: valueCount } = await admin
      .from("product_option_values")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("product_id", PRODUCT_ACTIVE_ID);
    expect(valueCount).toBe(2);

    const { count: priceCount } = await admin
      .from("variant_prices")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "active");
    expect(priceCount).toBe(3); // two active-product variants + one draft-product variant

    // Inventory: opening 25/40/12 minus the fulfillment issue (3 of M, 1 of L). All primary balances
    // live on the original location; the second location starts empty.
    const balances = await balancesByVariant(tenantId);
    expect(balances.get(VARIANT_M_ID)).toBe(22);
    expect(balances.get(VARIANT_L_ID)).toBe(39);
    expect(balances.get(VARIANT_TOTE_ID)).toBe(12);

    // Inventory locations: two active locations both usable for the Phase 2G writes. Every write flag is
    // enabled on both so receive and transfer (source + destination) work through normal authorization;
    // the second location suits Transfer as a distinct destination.
    const { data: locations } = await admin
      .from("inventory_locations")
      .select(
        "id,status,is_receiving_enabled,is_transfer_origin_enabled,is_transfer_destination_enabled",
      )
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true });
    expect(locations?.map((l) => l.id).sort()).toEqual([LOCATION_ID, LOCATION_2_ID].sort());
    for (const location of locations ?? []) {
      expect(location.status).toBe("active");
      expect(location.is_receiving_enabled).toBe(true);
      expect(location.is_transfer_origin_enabled).toBe(true);
      expect(location.is_transfer_destination_enabled).toBe(true);
    }

    // The second location carries no stock yet (a valid empty balance): no balance rows reference it.
    const { count: location2Balances } = await admin
      .from("inventory_balances")
      .select("variant_id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("inventory_location_id", LOCATION_2_ID);
    expect(location2Balances).toBe(0);

    // Order: one placed online order with two lines.
    const { data: orders } = await admin
      .from("orders")
      .select("id,status,channel,total_minor")
      .eq("tenant_id", tenantId);
    expect(orders).toHaveLength(1);
    expect(orders?.[0].status).toBe("placed");
    expect(orders?.[0].channel).toBe("online");
    expect(Number(orders?.[0].total_minor)).toBe(12995);
    const { count: lineCount } = await admin
      .from("order_lines")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("order_id", orders?.[0].id);
    expect(lineCount).toBe(2);

    // Fulfillment: one fulfillment with two lines (partial overall).
    const { data: fulfillments } = await admin
      .from("fulfillments")
      .select("id")
      .eq("tenant_id", tenantId);
    expect(fulfillments).toHaveLength(1);
    const { count: fulfillmentLineCount } = await admin
      .from("fulfillment_lines")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("fulfillment_id", fulfillments?.[0].id);
    expect(fulfillmentLineCount).toBe(2);
  });

  it("(idempotent) a second run changes nothing (same ids, same balances, no duplicates)", async () => {
    const tenantId = (await devTenantId()) as string;

    const result = provisionFixture();
    expect(result.status).toBe(0);

    expect(await countProducts(tenantId)).toBe(2);
    // Exactly the two deterministic locations remain: a re-run never duplicates them.
    const { count: locationCount } = await admin
      .from("inventory_locations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    expect(locationCount).toBe(2);
    const { data: registers, count: registerCount } = await admin
      .from("registers")
      .select("display_name,status,default_inventory_location_id,selling_currency", {
        count: "exact",
      })
      .eq("tenant_id", tenantId);
    expect(registerCount).toBe(1);
    expect(registers?.[0]).toMatchObject({
      display_name: "Dev Front Register",
      status: "active",
      default_inventory_location_id: LOCATION_ID,
      selling_currency: "USD",
    });
    const { count: orderCount } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    expect(orderCount).toBe(1);
    const { count: fulfillmentCount } = await admin
      .from("fulfillments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    expect(fulfillmentCount).toBe(1);

    // Balances are unchanged: the opening + issue replayed to the same operations and deducted nothing.
    const balances = await balancesByVariant(tenantId);
    expect(balances.get(VARIANT_M_ID)).toBe(22);
    expect(balances.get(VARIANT_L_ID)).toBe(39);
    expect(balances.get(VARIANT_TOTE_ID)).toBe(12);
  });

  it("(no extra authorization) the fixture grants no permissions or roles", async () => {
    const tenantId = (await devTenantId()) as string;

    // Identity provisioning owns separate exact management and POS cashier roles; the commerce
    // fixture never touches roles/permissions/scopes. The union includes management plus Connected POS
    // inventory writes (receive/adjust/transfer/issue) — deliberately WITHOUT opening or any wildcard.
    const { count: roleCount } = await admin
      .from("roles")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    expect(roleCount).toBe(2);

    const { data: grants, count: grantCount } = await admin
      .from("role_permissions")
      .select("permission_id, permissions(key)", { count: "exact" })
      .eq("tenant_id", tenantId);
    expect(grantCount).toBe(13);

    type Grant = { permissions: { key: string } | { key: string }[] | null };
    const grantedKeys = ((grants ?? []) as Grant[])
      .flatMap((g) => {
        const p = g.permissions;
        if (!p) return [];
        return Array.isArray(p) ? p.map((x) => x.key) : [p.key];
      })
      .sort();
    expect(new Set(grantedKeys)).toEqual(
      new Set([
        "catalog.read",
        "inventory.read",
        "orders.read",
        "inventory.receive",
        "inventory.adjust",
        "inventory.transfer",
        "inventory.issue",
        "orders.create",
        "orders.fulfill",
        "payments.capture",
      ]),
    );
    // Explicitly absent: opening stock, generic issue, other-domain writes, and any wildcard/admin grant.
    for (const forbidden of ["inventory.opening", "catalog.create", "orders.cancel"]) {
      expect(grantedKeys).not.toContain(forbidden);
    }
    expect(grantedKeys.some((k) => k.includes("*"))).toBe(false);
  });
});

async function balancesByVariant(tenantId: string): Promise<Map<string, number>> {
  const { data } = await admin
    .from("inventory_balances")
    .select("variant_id,on_hand_quantity")
    .eq("tenant_id", tenantId);
  const map = new Map<string, number>();
  for (const row of data ?? []) {
    map.set(row.variant_id, Number(row.on_hand_quantity));
  }
  return map;
}
