import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { createCommerceClient, type CreateReturnInput } from "../../packages/sdk/src";

const url = process.env.RETURNS_TEST_URL;
const container = process.env.RETURNS_TEST_CONTAINER;
if (!url || !container || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Run pnpm test:returns:integration with its isolated disposable environment.");
const T = "2a000001-0000-4000-8000-000000000001",
  B = "2a000002-0000-4000-8000-000000000001",
  V = "2a000007-0000-4000-8000-000000000001",
  L = "2a000004-0000-4000-8000-000000000001",
  R = "2a000005-0000-4000-8000-000000000001";
const sdk = createCommerceClient({
  baseUrl: url,
  getToken: () => process.env.RETURNS_TEST_TOKEN,
  client: { type: "admin-mobile", version: "0.1.0" },
});
const client = sdk.withTenant(T);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
function sql(source: string) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container!,
      "psql",
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
    ],
    { input: source, encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
const key = () => crypto.randomUUID();
async function sale(quantity = 2) {
  return client.createPosSale({
    registerId: R,
    lines: [{ variantId: V, quantity }],
    expectedTotalMinor: 2500 * quantity,
    cashReceivedMinor: 2500 * quantity,
    idempotencyKey: key(),
  });
}
function balance() {
  return Number(
    sql(
      `select on_hand_quantity from inventory_balances where tenant_id='${T}' and variant_id='${V}' and inventory_location_id='${L}'`,
    ),
  );
}
function intent(
  orderId: string,
  orderLineId: string,
  overrides: Partial<CreateReturnInput> = {},
): CreateReturnInput {
  return {
    orderId,
    idempotencyKey: key(),
    inventoryLocationId: L,
    refundMode: "manual_confirmed",
    settlementReference: "Cash handed to customer",
    lines: [{ orderLineId, quantity: 1, reason: "size", disposition: "restock" }],
    ...overrides,
  };
}
function counts() {
  return sql(
    "select jsonb_build_array((select count(*) from returns),(select count(*) from return_lines),(select count(*) from refunds),(select count(*) from inventory_operations));",
  );
}
beforeAll(() => {
  sql(
    `set role service_role; select inventory_private.record_operation('${T}','receipt','[{"variant_id":"${V}","inventory_location_id":"${L}","quantity_delta":100}]',null,'returns-test-stock');`,
  );
});

describe.sequential("canonical returns over real HTTP and PostgreSQL", () => {
  it("POS: sells 2, returns 1, records cash settlement, restocks 1 and projects immutable order history", async () => {
    const s = await sale();
    const before = balance();
    const eligible = await client.getReturnEligibility(s.order.id);
    expect(eligible.lines[0]).toMatchObject({
      purchasedQuantity: 2,
      fulfilledQuantity: 2,
      eligibleQuantity: 2,
    });
    const result = await client.createReturn(intent(s.order.id, s.order.lines[0].id));
    expect(result).toMatchObject({
      channel: "pos",
      status: "accepted",
      amountMinor: 2500,
      refund: { status: "succeeded", amountMinor: 2500, paymentId: s.payment.id },
    });
    expect(balance()).toBe(before + 1);
    const order = await client.getOrder(s.order.id);
    expect(order.header.totalMinor).toBe(5000);
    expect(order.header.status).toBe("placed");
    expect(order.lines[0].quantity).toBe(2);
    expect(order.returns).toMatchObject({ refundedMinor: 2500, lines: [{ returnedQuantity: 1 }] });
    expect(order.commerce?.payment?.status).toBe("captured");
    expect((await client.getReturn(result.id)).id).toBe(result.id);
  });
  it("rejects 2 more after returning 1 of 2 without any artifacts", async () => {
    const s = await sale();
    await client.createReturn(intent(s.order.id, s.order.lines[0].id));
    const before = counts();
    await expect(
      client.createReturn(
        intent(s.order.id, s.order.lines[0].id, {
          lines: [
            {
              orderLineId: s.order.lines[0].id,
              quantity: 2,
              reason: "size",
              disposition: "restock",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED", status: 409 });
    expect(counts()).toBe(before);
  });
  it("non-restock records a refund without increasing sellable inventory", async () => {
    const s = await sale(1);
    const before = balance();
    const r = await client.createReturn(
      intent(s.order.id, s.order.lines[0].id, {
        inventoryLocationId: null,
        lines: [
          {
            orderLineId: s.order.lines[0].id,
            quantity: 1,
            reason: "damaged",
            disposition: "non_restock",
          },
        ],
      }),
    );
    expect(r.inventoryOperationId).toBeNull();
    expect(r.refund.status).toBe("succeeded");
    expect(balance()).toBe(before);
  });
  it("exact retry returns the same Return, Refund and receipt, even after policy changes", async () => {
    const s = await sale();
    const command = intent(s.order.id, s.order.lines[0].id);
    const a = await client.createReturn(command);
    const before = counts();
    sql(`update return_settings set enabled=false where tenant_id='${T}'`);
    try {
      expect(await client.createReturn(command)).toEqual(a);
    } finally {
      sql(`update return_settings set enabled=true where tenant_id='${T}'`);
    }
    expect(counts()).toBe(before);
    await expect(
      client.createReturn({ ...command, settlementReference: "different evidence" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("multiple partial returns exactly exhaust the paid amount; history paginates without duplication", async () => {
    const s = await sale(3);
    for (let i = 0; i < 3; i++) await client.createReturn(intent(s.order.id, s.order.lines[0].id));
    const e = await client.getReturnEligibility(s.order.id);
    expect(e.eligible).toBe(false);
    expect(e.maxRefundableMinor).toBe(0);
    expect(e.lines[0].eligibleQuantity).toBe(0);
    const first = await client.listReturns(s.order.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = await client.listReturns(s.order.id, {
      limit: 2,
      cursor: first.pageInfo.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(3);
    expect((await client.getOrder(s.order.id)).returns?.refundedMinor).toBe(7500);
  });
  it("full return calculates from immutable snapshot after catalog price changes", async () => {
    const s = await sale(2);
    sql(
      `set role service_role; select catalog_private.set_variant_price('${T}','${V}','USD',9000,'returns-price-change');`,
    );
    try {
      const r = await client.createReturn(
        intent(s.order.id, s.order.lines[0].id, {
          lines: [
            {
              orderLineId: s.order.lines[0].id,
              quantity: 2,
              reason: "size",
              disposition: "restock",
            },
          ],
        }),
      );
      expect(r.amountMinor).toBe(5000);
      expect(r.refund.amountMinor).toBe(5000);
    } finally {
      sql(
        `set role service_role; select catalog_private.set_variant_price('${T}','${V}','USD',2500,'returns-price-restore');`,
      );
    }
  });
  it("rejects injected totals, zero quantities, duplicates, and lines from another order", async () => {
    const a = await sale(),
      b = await sale();
    const good = intent(a.order.id, a.order.lines[0].id);
    const send = (body: unknown) =>
      fetch(`${url}/api/v1/orders/${a.order.id}/returns`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RETURNS_TEST_TOKEN}`,
          "X-Tenant-Id": T,
          "Idempotency-Key": key(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await send({ lines: good.lines, amountMinor: 1 })).status).toBe(400);
    expect((await send({ lines: [{ ...good.lines[0], quantity: 0 }] })).status).toBe(400);
    await expect(
      client.createReturn({ ...good, lines: [good.lines[0], good.lines[0]] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.createReturn({
        ...good,
        lines: [{ ...good.lines[0], orderLineId: b.order.lines[0].id }],
      }),
    ).rejects.toMatchObject({ code: "ORDER_LINE_MISMATCH" });
  });
  it("authorization denies missing create permission, wrong branch and cross-tenant reads/writes", async () => {
    const s = await sale();
    const command = intent(s.order.id, s.order.lines[0].id);
    for (const token of [
      process.env.RETURNS_TEST_DENIED_TOKEN,
      process.env.RETURNS_TEST_SCOPED_TOKEN,
    ]) {
      const denied = createCommerceClient({ baseUrl: url!, getToken: () => token }).withTenant(T);
      await expect(denied.createReturn(command)).rejects.toMatchObject({ status: 403 });
      await expect(denied.getReturnEligibility(s.order.id)).rejects.toMatchObject({ status: 403 });
    }
    const result = await client.createReturn(command);
    await expect(
      sdk.withTenant("2a000001-0000-4000-8000-000000000002").getReturn(result.id),
    ).rejects.toMatchObject({ status: 403 });
    const foreign = await db.schema("returns_private").rpc("return_detail", {
      p_tenant: "2a000001-0000-4000-8000-000000000002",
      p_return: result.id,
    });
    expect(foreign.data).toBeNull();
    expect(
      (
        await db.schema("returns_private").rpc("accept_return", {
          p_tenant: "2a000001-0000-4000-8000-000000000002",
          p_order: s.order.id,
          p_actor: "2a000012-0000-4000-8000-000000000001",
          p_source: "management",
          p_key: key(),
          p_intent: {
            lines: command.lines,
            inventoryLocationId: L,
            refundMode: "pending",
            settlementReference: null,
          },
        })
      ).error?.code,
    ).toBe("RT404");
  });
  it("separately requires refund and restock permissions, including on replay", async () => {
    const s = await sale();
    const command = intent(s.order.id, s.order.lines[0].id);
    await client.createReturn(command);
    for (const permission of ["payments.refund", "inventory.receive"]) {
      sql(
        `delete from role_permissions where role_id='2a000013-0000-4000-8000-000000000001' and permission_id=(select id from permissions where key='${permission}')`,
      );
      try {
        await expect(client.createReturn(command)).rejects.toMatchObject({ status: 403 });
      } finally {
        sql(
          `insert into role_permissions(tenant_id,role_id,permission_id) select '${T}','2a000013-0000-4000-8000-000000000001',id from permissions where key='${permission}'`,
        );
      }
    }
  });
  it("applies configured window, reasons, disabled state and manual approval threshold", async () => {
    const s = await sale();
    const command = intent(s.order.id, s.order.lines[0].id);
    for (const [setting, code] of [
      ["enabled=false", "RETURNS_DISABLED"],
      ["window_days=0", "RETURN_WINDOW_EXPIRED"],
      ["allowed_reasons=array['other']", "RETURN_REASON_NOT_ALLOWED"],
      ["max_manual_refund_minor=100", "MANUAL_REFUND_NOT_ALLOWED"],
    ] as const) {
      sql(`update return_settings set ${setting} where tenant_id='${T}'`);
      try {
        await expect(client.createReturn(command)).rejects.toMatchObject({ code });
      } finally {
        sql(
          `update return_settings set enabled=true,window_days=30,allowed_reasons=null,max_manual_refund_minor=null where tenant_id='${T}'`,
        );
      }
    }
  });
  it("records pending manual refunds and settles once with evidence and stable retry", async () => {
    const s = await sale(1);
    const r = await client.createReturn(
      intent(s.order.id, s.order.lines[0].id, { refundMode: "pending", settlementReference: null }),
    );
    expect(r.refund.status).toBe("pending");
    expect((await client.getOrder(s.order.id)).returns?.pendingRefundMinor).toBe(2500);
    const command = {
      returnId: r.id,
      idempotencyKey: key(),
      settlementReference: "Till reconciliation 123",
    };
    const settled = await client.settleRefund(command);
    expect(settled.refund.status).toBe("succeeded");
    expect(await client.settleRefund(command)).toEqual(settled);
    await expect(
      client.settleRefund({ ...command, settlementReference: "changed" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(client.settleRefund({ ...command, idempotencyKey: key() })).rejects.toMatchObject({
      code: "REFUND_CONFLICT",
    });
  });
  it("rolls receipt, return lines, return and refund back when the final refund insert fails", async () => {
    const s = await sale();
    const command = intent(s.order.id, s.order.lines[0].id);
    const before = counts(),
      stock = balance();
    sql(
      "create function public.fail_return_test() returns trigger language plpgsql as $$begin raise exception 'injected refund failure';end$$; create trigger fail_return_test before insert on refunds for each row execute function public.fail_return_test();",
    );
    try {
      await expect(client.createReturn(command)).rejects.toMatchObject({ status: 500 });
    } finally {
      sql("drop trigger fail_return_test on refunds;drop function public.fail_return_test();");
    }
    expect(counts()).toBe(before);
    expect(balance()).toBe(stock);
    await client.createReturn(command);
    expect(balance()).toBe(stock + 1);
  });
  it("concurrent final-quantity requests have one winner and no duplicate refund/restock", async () => {
    const s = await sale(1);
    const before = balance();
    const results = await Promise.allSettled([
      client.createReturn(intent(s.order.id, s.order.lines[0].id)),
      client.createReturn(intent(s.order.id, s.order.lines[0].id)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "RETURN_QUANTITY_EXCEEDED",
    });
    expect(balance()).toBe(before + 1);
    expect((await client.listReturns(s.order.id)).items).toHaveLength(1);
  });
  it("concurrent exact retries share all durable identifiers", async () => {
    const s = await sale(1);
    const command = intent(s.order.id, s.order.lines[0].id);
    const stock = balance();
    const [a, b] = await Promise.all([client.createReturn(command), client.createReturn(command)]);
    expect(a).toEqual(b);
    expect(balance()).toBe(stock + 1);
  });
  it("enforces the independent payment ceiling even with remaining eligible merchandise", async () => {
    const s = await sale(2);
    await client.createReturn(
      intent(s.order.id, s.order.lines[0].id, { refundMode: "pending", settlementReference: null }),
    );
    // Trusted test injection models an already committed payment refund consuming the remaining paid
    // ceiling. The public/service role cannot perform this write. Quantity eligibility is still one.
    sql(
      `set role returns_writer; update refunds set amount_minor=5000 where order_id='${s.order.id}';`,
    );
    const before = counts();
    await expect(
      client.createReturn(intent(s.order.id, s.order.lines[0].id)),
    ).rejects.toMatchObject({ code: "REFUND_CONFLICT" });
    expect(counts()).toBe(before);
  });
  it("ONLINE pending COD has no refundable cash; captured/fulfilled COD uses the same return domain", async () => {
    const receipt = await sdk.checkout({
      tenantId: T,
      brandId: B,
      lines: [{ variantId: V, quantity: 1 }],
      customer: { name: "Return Guest", phone: "+201001234567", email: null },
      delivery: {
        recipientName: "Guest",
        phone: "+201001234567",
        line1: "Street",
        line2: null,
        city: "Cairo",
        region: null,
        postalCode: null,
        countryCode: "EG",
        notes: null,
      },
      expectedTotalMinor: 2500,
      expectedCurrency: "USD",
      paymentMethod: "cash_on_delivery",
      idempotencyKey: key(),
    });
    const orders = await client.listOrders({ channel: "online" });
    const o = orders.items.find((o) => o.orderNumber === receipt.orderReference)!;
    const line = sql(`select id from order_lines where order_id='${o.id}'`);
    const command = intent(o.id, line);
    const wrongScope = createCommerceClient({
      baseUrl: url!,
      getToken: () => process.env.RETURNS_TEST_SCOPED_TOKEN,
    }).withTenant(T);
    await expect(wrongScope.createReturn(command)).rejects.toMatchObject({ status: 403 });
    expect((await client.getReturnEligibility(o.id)).reason).toBe("PAYMENT_NOT_CAPTURED");
    await expect(client.createReturn(command)).rejects.toMatchObject({
      code: "PAYMENT_NOT_CAPTURED",
    });
    // Test-only real payment transition; this is not a new collection API or fabricated gateway.
    sql(
      `set role payments_writer;select payments_private.transition_payment('${T}','${o.id}','captured');`,
    );
    await expect(client.createReturn(command)).rejects.toMatchObject({
      code: "RETURN_QUANTITY_EXCEEDED",
    });
    const f = await db.schema("fulfillments_private").rpc("record_fulfillment", {
      p_tenant_id: T,
      p_order_id: o.id,
      p_inventory_location_id: L,
      p_actor_membership_id: null,
      p_idempotency_key: key(),
      p_fulfilled_at: null,
      p_lines: [{ order_line_id: line, quantity: 1 }],
    });
    expect(f.error).toBeNull();
    const r = await client.createReturn(command);
    expect(r.channel).toBe("online");
    expect(r.refund).toMatchObject({
      method: "cash_on_delivery",
      status: "succeeded",
      amountMinor: 2500,
    });
  });
  it("electronic refund remains pending and cannot be claimed as manually settled", async () => {
    const s = await sale(1);
    // Disposable provider-neutral captured fixture only, not a gateway success simulation.
    sql(
      `alter table payments disable trigger payments_immutable; update payments set method='electronic',provider='test-only' where order_id='${s.order.id}'; alter table payments enable trigger payments_immutable;`,
    );
    const command = intent(s.order.id, s.order.lines[0].id);
    await expect(client.createReturn(command)).rejects.toMatchObject({
      code: "MANUAL_REFUND_NOT_ALLOWED",
    });
    const r = await client.createReturn({
      ...command,
      refundMode: "pending",
      settlementReference: null,
    });
    expect(r.refund.status).toBe("pending");
    await expect(
      client.settleRefund({
        returnId: r.id,
        idempotencyKey: key(),
        settlementReference: "cannot attest a gateway",
      }),
    ).rejects.toMatchObject({ code: "MANUAL_REFUND_NOT_ALLOWED" });
  });
  it("rejects direct table writes and preserves composite tenant/order/line containment", async () => {
    for (const role of ["anon", "authenticated", "service_role"])
      for (const table of ["returns", "return_lines", "refunds"])
        expect(() => sql(`set role ${role};delete from ${table}`)).toThrow(/permission denied/);
    const s = await sale(),
      other = await sale();
    const r = await client.createReturn(intent(s.order.id, s.order.lines[0].id));
    expect(() =>
      sql(
        `set role returns_writer;insert into return_lines(tenant_id,return_id,order_id,order_line_id,variant_id,quantity,reason,disposition,amount_minor) values('${T}','${r.id}','${s.order.id}','${other.order.lines[0].id}','${V}',1,'test','non_restock',2500)`,
      ),
    ).toThrow(/foreign key/);
  });
  it("requires auth and idempotency headers and denies missing resources", async () => {
    const s = await sale();
    const endpoint = `${url}/api/v1/orders/${s.order.id}/returns`;
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "X-Tenant-Id": T, "Idempotency-Key": key() },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "X-Tenant-Id": T, Authorization: `Bearer ${process.env.RETURNS_TEST_TOKEN}` },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    await expect(client.getReturn(key())).rejects.toMatchObject({ status: 404 });
    await expect(client.getReturnEligibility(key())).rejects.toMatchObject({ status: 404 });
  });
});
