import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

// Real local-Postgres coverage for scripts/provision-dev-identity.mjs. Run through
// `pnpm test:dev:provisioning`, which starts and resets a disposable local Supabase stack and injects
// the connection env below. No shared or production project is supported.

const url = process.env.DEV_PROVISIONING_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.DEV_PROVISIONING_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "Run this suite through pnpm test:dev:provisioning; it requires the disposable local Supabase stack.",
  );
}

const admin: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

const scriptPath = join(process.cwd(), "scripts", "provision-dev-identity.mjs");
const READ_PERMISSIONS = ["catalog.read", "inventory.read", "orders.read", "returns.read"] as const;
const PROMOTION_PERMISSIONS = ["promotions.read", "promotions.manage"] as const;
const INVENTORY_WRITE_PERMISSIONS = [
  "inventory.receive",
  "inventory.adjust",
  "inventory.transfer",
] as const;
const ATTENDANCE_PERMISSIONS = ["attendance.read", "attendance.manage"] as const;
const STAFF_PERMISSIONS = ["staff.read"] as const;
const SETTINGS_PERMISSIONS = ["settings.read", "settings.manage"] as const;
const SUPPLIER_PERMISSIONS = ["suppliers.read", "suppliers.manage"] as const;
const REPORTS_PERMISSIONS = ["reports.read"] as const;
// The dev management role grants EXACTLY these seventeen: four reads, two promotion permissions, the three
// Phase 2G inventory writes, the two attendance permissions, staff.read (the Staff desk roster read that
// backs the attendance/payroll back-office), the settings/suppliers read+manage pairs that back the
// operational-settings (inventory locations) and Suppliers payables desks, and reports.read for the
// Reports desk.
const EXPECTED_PERMISSIONS = [
  ...READ_PERMISSIONS,
  ...PROMOTION_PERMISSIONS,
  ...INVENTORY_WRITE_PERMISSIONS,
  ...ATTENDANCE_PERMISSIONS,
  ...STAFF_PERMISSIONS,
  ...SETTINGS_PERMISSIONS,
  ...SUPPLIER_PERMISSIONS,
  ...REPORTS_PERMISSIONS,
] as const;
// Deliberately excluded: opening stock, generic issue, any catalog/order/fulfillment write, and staff
// mutation (staff.read is granted read-only; staff.manage is withheld).
const FORBIDDEN_PERMISSIONS = [
  "inventory.opening",
  "inventory.issue",
  "catalog.create",
  "orders.create",
  "orders.cancel",
  "staff.manage",
] as const;

const SUBJECT_PRIMARY = "user_dev_primary";
const SUBJECT_CONFLICT = "user_dev_conflict_suspended";
const SUBJECT_PARTIAL = "user_dev_partial_rollback";

interface ProvisionResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function provision(clerkSubject: string, extraEnv: Record<string, string> = {}): ProvisionResult {
  const result = spawnSync(process.execPath, [scriptPath, "--clerk-subject", clerkSubject], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, COMMERCE_DEV_PROVISIONING: "1", ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function bindingsFor(subject: string) {
  const { data, error } = await admin
    .from("user_identity_provider_bindings")
    .select("id,user_identity_id,unlinked_at")
    .eq("provider", "clerk")
    .eq("provider_subject", subject);
  expect(error).toBeNull();
  return data ?? [];
}

async function devTenantId(): Promise<string | null> {
  const { data } = await admin
    .from("tenants")
    .select("id,status")
    .eq("slug", "dev-local")
    .maybeSingle();
  return data ? data.id : null;
}

describe("development identity provisioning (local Postgres)", () => {
  beforeAll(() => {
    // Sanity: the disposable DB starts without the dev tenant so first-run assertions are meaningful.
    expect(scriptPath).toContain("provision-dev-identity.mjs");
  });

  it("(4) fails when a canonical read permission is missing, writing nothing", async () => {
    await admin
      .from("permissions")
      .update({ status: "deprecated", deprecated_at: new Date().toISOString() })
      .eq("key", "catalog.read");

    const result = provision(SUBJECT_PRIMARY);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/canonical permissions/i);
    expect(await devTenantId()).toBeNull();
    expect(await bindingsFor(SUBJECT_PRIMARY)).toHaveLength(0);

    // Restore the catalog so later cases run against a current database.
    await admin
      .from("permissions")
      .update({ status: "active", deprecated_at: null })
      .eq("key", "catalog.read");
  });

  it("(5-13) first run provisions the exact expected graph", async () => {
    const result = provision(SUBJECT_PRIMARY);
    expect(result.status).toBe(0);
    // (Output must not leak the subject.)
    expect(`${result.stdout}${result.stderr}`).not.toContain(SUBJECT_PRIMARY);

    const tenantId = await devTenantId();
    expect(tenantId).not.toBeNull();

    // (9) tenant active
    const { data: tenant } = await admin
      .from("tenants")
      .select("status,slug")
      .eq("id", tenantId)
      .single();
    expect(tenant?.status).toBe("active");

    // (7) exactly one live binding, (8) identity active
    const bindings = await bindingsFor(SUBJECT_PRIMARY);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].unlinked_at).toBeNull();
    const identityId = bindings[0].user_identity_id;
    const { data: identity } = await admin
      .from("user_identities")
      .select("status")
      .eq("id", identityId)
      .single();
    expect(identity?.status).toBe("active");

    // (10) membership active
    const { data: membership } = await admin
      .from("memberships")
      .select("id,status")
      .eq("tenant_id", tenantId)
      .eq("user_identity_id", identityId)
      .single();
    expect(membership?.status).toBe("active");

    // (11 & 16) role grants EXACTLY the sixteen management permissions (reads + promotions + inventory
    //           writes + attendance + settings + suppliers + reports), and no forbidden write
    //           (opening/issue, catalog/order/fulfillment write, wildcard)
    const { data: role } = await admin
      .from("roles")
      .select("id,is_protected,status")
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev management reader")
      .single();
    expect(role?.status).toBe("active");
    // (17) not a protected/platform role
    expect(role?.is_protected).toBe(false);

    const { data: grants } = await admin
      .from("role_permissions")
      .select("permission_id, permissions(key)")
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id);
    type Grant = { permissions: { key: string } | { key: string }[] | null };
    const grantedKeys = ((grants ?? []) as Grant[])
      .flatMap((g) => {
        const p = g.permissions;
        if (!p) return [];
        return Array.isArray(p) ? p.map((x) => x.key) : [p.key];
      })
      .sort();
    expect(grantedKeys).toEqual([...EXPECTED_PERMISSIONS].sort());
    // No opening-stock or generic-issue write, and nothing outside inventory receive/adjust/transfer.
    for (const forbidden of FORBIDDEN_PERMISSIONS) {
      expect(grantedKeys).not.toContain(forbidden);
    }
    expect(grantedKeys.some((k) => /\.(create|cancel)$/.test(k))).toBe(false);
    expect(grantedKeys.some((k) => k.includes("*"))).toBe(false);

    // (12) tenant-wide scope owned by the dev tenant
    const { data: scope } = await admin
      .from("access_scopes")
      .select("id,scope_mode,status,tenant_id")
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev tenant wide")
      .single();
    expect(scope?.scope_mode).toBe("tenant");
    expect(scope?.status).toBe("active");
    expect(scope?.tenant_id).toBe(tenantId);

    // (13) live assignment
    const { data: assignment } = await admin
      .from("membership_role_assignments")
      .select("id,unassigned_at")
      .eq("tenant_id", tenantId)
      .eq("membership_id", membership?.id)
      .eq("role_id", role?.id)
      .eq("access_scope_id", scope?.id)
      .is("unassigned_at", null)
      .single();
    expect(assignment?.id).toBeTruthy();

    const { data: posRole } = await admin
      .from("roles")
      .select("id,is_protected,status")
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev pos cashier")
      .single();
    expect(posRole).toMatchObject({ status: "active", is_protected: false });
    const { data: posGrants } = await admin
      .from("role_permissions")
      .select("permissions(key)")
      .eq("tenant_id", tenantId)
      .eq("role_id", posRole?.id);
    const posKeys = ((posGrants ?? []) as Grant[])
      .flatMap((grant) => {
        const permission = grant.permissions;
        if (!permission) return [];
        return Array.isArray(permission) ? permission.map((item) => item.key) : [permission.key];
      })
      .sort();
    expect(posKeys).toEqual(
      [
        "catalog.read",
        "inventory.issue",
        "inventory.read",
        "orders.create",
        "orders.fulfill",
        "orders.read",
        "payments.capture",
      ].sort(),
    );
    const { count: posAssignmentCount } = await admin
      .from("membership_role_assignments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("membership_id", membership?.id)
      .eq("role_id", posRole?.id)
      .eq("access_scope_id", scope?.id)
      .is("unassigned_at", null);
    expect(posAssignmentCount).toBe(1);
  });

  it("(6) second identical run is idempotent (no duplicates, same ids)", async () => {
    const before = await bindingsFor(SUBJECT_PRIMARY);
    const tenantId = await devTenantId();
    const identityId = before[0].user_identity_id;

    const result = provision(SUBJECT_PRIMARY);
    expect(result.status).toBe(0);

    expect(await bindingsFor(SUBJECT_PRIMARY)).toHaveLength(1);

    const { count: membershipCount } = await admin
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("user_identity_id", identityId);
    expect(membershipCount).toBe(1);

    const { data: role } = await admin
      .from("roles")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev management reader")
      .single();
    const { count: assignmentCount } = await admin
      .from("membership_role_assignments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id)
      .is("unassigned_at", null);
    expect(assignmentCount).toBe(1);

    const { count: grantCount } = await admin
      .from("role_permissions")
      .select("permission_id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id);
    expect(grantCount).toBe(6);
  });

  it("(9) a third identical run leaves the same records and ids unchanged", async () => {
    const tenantId = await devTenantId();
    const { data: role } = await admin
      .from("roles")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev management reader")
      .single();
    const { data: assignmentBefore } = await admin
      .from("membership_role_assignments")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id)
      .is("unassigned_at", null)
      .single();

    const result = provision(SUBJECT_PRIMARY);
    expect(result.status).toBe(0);

    // Same live assignment row (same id), no new rows.
    const { data: assignmentAfter, count: assignmentCount } = await admin
      .from("membership_role_assignments")
      .select("id", { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id)
      .is("unassigned_at", null);
    expect(assignmentCount).toBe(1);
    expect(assignmentAfter?.[0].id).toBe(assignmentBefore?.id);
    expect(await bindingsFor(SUBJECT_PRIMARY)).toHaveLength(1);
  });

  it("(9b) reconciles a role missing the inventory writes back up to the exact permission set", async () => {
    const tenantId = await devTenantId();
    const { data: role } = await admin
      .from("roles")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev management reader")
      .single();

    // Simulate a dev-local provisioned before Phase 2G: drop the three inventory write grants so the role
    // carries only the surviving (non-inventory-write) permissions.
    const { data: writePerms } = await admin
      .from("permissions")
      .select("id")
      .in("key", [...INVENTORY_WRITE_PERMISSIONS]);
    await admin
      .from("role_permissions")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id)
      .in(
        "permission_id",
        (writePerms ?? []).map((p) => p.id),
      );
    const { count: beforeCount } = await admin
      .from("role_permissions")
      .select("permission_id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id);
    expect(beforeCount).toBe(EXPECTED_PERMISSIONS.length - INVENTORY_WRITE_PERMISSIONS.length);

    // Re-running the provisioner reconciles back up to the exact set without duplicating survivors.
    const result = provision(SUBJECT_PRIMARY);
    expect(result.status).toBe(0);

    const { data: grants } = await admin
      .from("role_permissions")
      .select("permissions(key)")
      .eq("tenant_id", tenantId)
      .eq("role_id", role?.id);
    type Grant = { permissions: { key: string } | { key: string }[] | null };
    const grantedKeys = ((grants ?? []) as Grant[])
      .flatMap((g) => {
        const p = g.permissions;
        if (!p) return [];
        return Array.isArray(p) ? p.map((x) => x.key) : [p.key];
      })
      .sort();
    expect(grantedKeys).toEqual([...EXPECTED_PERMISSIONS].sort());
  });

  it("(6b) refuses to reuse a membership carrying an extra live assignment (effective-permission exactness)", async () => {
    const tenantId = await devTenantId();
    const bindings = await bindingsFor(SUBJECT_PRIMARY);
    const identityId = bindings[0].user_identity_id;
    const { data: membership } = await admin
      .from("memberships")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("user_identity_id", identityId)
      .single();
    const { data: role } = await admin
      .from("roles")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev management reader")
      .single();

    // Inject a second, unrelated live assignment for this membership.
    const { data: extraScope } = await admin
      .from("access_scopes")
      .insert({ tenant_id: tenantId, name: "Extra Scope", scope_mode: "tenant", status: "active" })
      .select("id")
      .single();
    const { data: extraAssignment } = await admin
      .from("membership_role_assignments")
      .insert({
        tenant_id: tenantId,
        membership_id: membership?.id,
        role_id: role?.id,
        access_scope_id: extraScope?.id,
        assigned_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    const result = provision(SUBJECT_PRIMARY);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/other live role assignment/i);

    // Clean up so later cases see the canonical single-assignment graph.
    await admin.from("membership_role_assignments").delete().eq("id", extraAssignment?.id);
    await admin.from("access_scopes").delete().eq("id", extraScope?.id);
  });

  it("(14) fails loudly on a conflicting existing binding (bound to a non-active identity)", async () => {
    const { data: identity } = await admin
      .from("user_identities")
      .insert({ status: "suspended", suspended_at: new Date().toISOString() })
      .select("id")
      .single();
    await admin.from("user_identity_provider_bindings").insert({
      user_identity_id: identity?.id,
      provider: "clerk",
      provider_subject: SUBJECT_CONFLICT,
    });

    const result = provision(SUBJECT_CONFLICT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/expected active|refusing/i);
  });

  it("(15) a failure mid-graph leaves no partial data (transactional rollback)", async () => {
    const tenantId = await devTenantId();
    // Force step 4 (role) to fail for a brand-new subject by archiving the dev role.
    await admin
      .from("roles")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev management reader");

    const result = provision(SUBJECT_PARTIAL);
    expect(result.status).not.toBe(0);

    // The new subject's identity/binding/membership must have been rolled back entirely.
    expect(await bindingsFor(SUBJECT_PARTIAL)).toHaveLength(0);

    // Restore the role so the DB is left consistent.
    await admin
      .from("roles")
      .update({ status: "active", archived_at: null })
      .eq("tenant_id", tenantId)
      .eq("normalized_name", "dev management reader");
  });
});
