import { describe, expect, it, vi } from "vitest";
import { createCommerceClient, ApiContractError } from "./index";

const id = "11111111-1111-4111-8111-111111111111";
const detail = {
  membershipId: id,
  identityId: id,
  tenantId: id,
  displayName: "Dana Manager",
  email: "dana@example.test",
  status: "active",
  roles: [],
  createdAt: "2026-09-22T00:00:00Z",
  updatedAt: "2026-09-22T00:00:00Z",
  invitedAt: "2026-09-22T00:00:00Z",
  activatedAt: "2026-09-22T00:00:00Z",
  suspendedAt: null,
  deactivatedAt: null,
  assignments: [],
};

describe("Staff SDK", () => {
  it("links an identity and transitions lifecycle with idempotent, tenant-scoped writes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(detail)));
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      getToken: () => "session",
      fetch: fetcher,
    }).withTenant(id);

    expect(await client.createStaff({ identityId: id, idempotencyKey: "create" })).toEqual(detail);
    const [createPath, createInit] = fetcher.mock.calls[0];
    expect(createPath).toBe("https://example.test/api/v1/staff");
    expect(createInit?.method).toBe("POST");
    expect(JSON.parse(createInit?.body as string)).toEqual({ identityId: id });
    expect(new Headers(createInit?.headers).get("Idempotency-Key")).toBe("create");
    expect(new Headers(createInit?.headers).get("X-Tenant-Id")).toBe(id);

    await client.updateStaffStatus({ membershipId: id, status: "suspended", idempotencyKey: "s" });
    const [statusPath, statusInit] = fetcher.mock.calls[1];
    expect(statusPath).toBe(`https://example.test/api/v1/staff/${id}`);
    expect(statusInit?.method).toBe("PATCH");
    expect(JSON.parse(statusInit?.body as string)).toEqual({ status: "suspended" });
  });

  it("provisions an email-less login over a tenant-scoped, idempotent POST", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(detail)));
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      getToken: () => "session",
      fetch: fetcher,
    }).withTenant(id);

    const result = await client.createStaffLogin({
      displayName: "Dana Cashier",
      username: "dana",
      pin: "1234",
      roleId: id,
      accessScopeId: id,
      idempotencyKey: "create-login",
    });
    expect(result).toEqual(detail);
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("https://example.test/api/v1/staff/logins");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      displayName: "Dana Cashier",
      username: "dana",
      pin: "1234",
      roleId: id,
      accessScopeId: id,
    });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("create-login");
    expect(new Headers(init?.headers).get("X-Tenant-Id")).toBe(id);
  });

  it("sets an offline PIN over a tenant-scoped, idempotent PUT to the membership sub-resource", async () => {
    const response = { membershipId: id, keyVersion: 1, updatedAt: "2026-10-24T00:00:00Z" };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      getToken: () => "session",
      fetch: fetcher,
    }).withTenant(id);

    const result = await client.setStaffOfflinePin({
      membershipId: id,
      pin: "4821",
      idempotencyKey: "set-pin",
    });
    expect(result).toEqual(response);
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`https://example.test/api/v1/staff/${id}/offline-pin`);
    expect(init?.method).toBe("PUT");
    // The membershipId is a path segment and must NOT leak into the body.
    expect(JSON.parse(init?.body as string)).toEqual({ pin: "4821" });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("set-pin");
    expect(new Headers(init?.headers).get("X-Tenant-Id")).toBe(id);
  });

  it("assigns and unassigns a role against the assignment sub-resource", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(detail)));
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);

    await client.assignStaffRole({
      membershipId: id,
      roleId: id,
      accessScopeId: id,
      idempotencyKey: "assign",
    });
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://example.test/api/v1/staff/${id}/role-assignments`,
    );
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");

    await client.unassignStaffRole({
      membershipId: id,
      assignmentId: id,
      reason: "left team",
      idempotencyKey: "unassign",
    });
    const [unassignPath, unassignInit] = fetcher.mock.calls[1];
    expect(unassignPath).toBe(`https://example.test/api/v1/staff/${id}/role-assignments/${id}`);
    expect(unassignInit?.method).toBe("DELETE");
    expect(JSON.parse(unassignInit?.body as string)).toEqual({ reason: "left team" });
  });

  it("encodes list filters and validates the detail envelope", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ items: [], pageInfo: { nextCursor: null, hasMore: false } })),
    );
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);
    await client.listStaff({ search: "dana", status: "active", roleId: id, limit: 5 });
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(query.get("search")).toBe("dana");
    expect(query.get("status")).toBe("active");
    expect(query.get("roleId")).toBe(id);

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ membershipId: "not-a-uuid" })));
    await expect(client.getStaffMember(id)).rejects.toBeInstanceOf(ApiContractError);
  });

  it("resolves an eligible identity by exact email over a tenant-scoped lookup", async () => {
    const identity = {
      identityId: id,
      displayName: "Dana Newhire",
      primaryEmail: "dana@example.test",
      status: "active",
    };
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ items: [identity] })),
    );
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);
    const result = await client.findEligibleStaffIdentitiesByEmail({ email: "dana@example.test" });
    expect(result.items[0]).toEqual(identity);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/staff/eligible-identities");
    expect(url.searchParams.get("email")).toBe("dana@example.test");
    expect(url.searchParams.get("search")).toBeNull();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("X-Tenant-Id")).toBe(id);
  });

  it("reads the assignment catalogs as tenant-scoped, paged, read-only lists", async () => {
    const role = {
      roleId: id,
      roleName: "Store Manager",
      description: null,
      isProtected: false,
      permissionKeys: ["staff.read"],
    };
    const scope = {
      accessScopeId: id,
      scopeName: "Main Branch",
      description: null,
      scopeMode: "explicit",
      targets: [{ kind: "branch", id, name: "Main Branch" }],
    };
    const page = { nextCursor: "next", hasMore: true };
    const fetcher = vi.fn<typeof fetch>(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).includes("assignable-roles")
              ? { items: [role], pageInfo: page }
              : { items: [scope], pageInfo: page },
          ),
        ),
    );
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);

    const roles = await client.listAssignableStaffRoles({ limit: 5 });
    expect(roles.items).toEqual([role]);
    const rolesUrl = new URL(String(fetcher.mock.calls[0][0]));
    expect(rolesUrl.pathname).toBe("/api/v1/staff/assignable-roles");
    expect(rolesUrl.searchParams.get("limit")).toBe("5");
    expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("X-Tenant-Id")).toBe(id);

    const scopes = await client.listAssignableStaffScopes({ cursor: "next" });
    expect(scopes.items).toEqual([scope]);
    const scopesUrl = new URL(String(fetcher.mock.calls[1][0]));
    expect(scopesUrl.pathname).toBe("/api/v1/staff/assignable-scopes");
    expect(scopesUrl.searchParams.get("cursor")).toBe("next");
  });

  it("rejects an assignment catalog page missing a contracted role field", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ roleId: id, roleName: "Store Manager", isProtected: false }],
            pageInfo: { nextCursor: null, hasMore: false },
          }),
        ),
    );
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);
    await expect(client.listAssignableStaffRoles()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("passes through every match when an email is shared (0..N), preferring none", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const first = {
      identityId: id,
      displayName: "Sam Alpha",
      primaryEmail: "shared@example.test",
      status: "active",
    };
    const second = { ...first, identityId: other, displayName: "Sam Beta" };
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ items: [first, second] })),
    );
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);
    const result = await client.findEligibleStaffIdentitiesByEmail({
      email: "shared@example.test",
    });
    expect(result.items).toEqual([first, second]);
  });
});
