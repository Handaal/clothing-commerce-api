import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { CheckoutResultSchema, OrderDetailResponseSchema } from "../../src/contracts";
import { createCommerceClient, ApiHttpError } from "../../packages/sdk/src";

const url = process.env.ONLINE_TEST_URL;
const dbUrl = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !dbUrl || !key)
  throw new Error("Use pnpm test:online:integration with the disposable database.");
const db = createClient(dbUrl, key, { auth: { persistSession: false } });
const sdk = createCommerceClient({ baseUrl: url });
const management = createCommerceClient({
  baseUrl: url,
  getToken: () => process.env.ONLINE_TEST_TOKEN,
});
const T = "2a000001-0000-4000-8000-000000000001";
const B = "2a000002-0000-4000-8000-000000000001";
const V = "2a000007-0000-4000-8000-000000000001";
const L = "2a000004-0000-4000-8000-000000000001";
const P = "2a000006-0000-4000-8000-000000000001";
const foreignT = "2a000001-0000-4000-8000-000000000002";
const intent = {
  tenantId: T,
  brandId: B,
  lines: [{ variantId: V, quantity: 1 }],
  customer: { name: "Guest", phone: "+20 100 123 4567", email: "Guest@example.com" },
  delivery: {
    recipientName: "Recipient",
    phone: "+201001234567",
    line1: "10 Example Street",
    line2: null,
    city: "Cairo",
    region: null,
    postalCode: null,
    countryCode: "EG",
    notes: null,
  },
  expectedTotalMinor: 2500,
  expectedCurrency: "USD",
  paymentMethod: "cash_on_delivery" as const,
};
function sql(source: string): string {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_clothing-commerce-api",
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
async function checkout(k: string, quantity = 1) {
  return sdk.checkout({
    ...intent,
    lines: [{ variantId: V, quantity }],
    expectedTotalMinor: 2500 * quantity,
    idempotencyKey: k,
  });
}
async function orderFor(k: string): Promise<string> {
  const r = await db
    .from("checkout_operations")
    .select("order_id")
    .eq("tenant_id", T)
    .eq("normalized_key", k)
    .single();
  if (r.error) throw new Error(r.error.message);
  return String(r.data.order_id);
}
async function cancel(order: string) {
  const r = await db.schema("orders_private").rpc("cancel_order", {
    p_tenant_id: T,
    p_order_id: order,
    p_cancelled_by_membership_id: null,
    p_reason: "Acceptance cancellation",
  });
  if (r.error) throw new Error(r.error.message);
}
async function counts() {
  return sql(
    "select jsonb_build_array((select count(*) from customers),(select count(*) from customer_addresses),(select count(*) from orders),(select count(*) from payments),(select count(*) from stock_reservations),(select count(*) from checkout_operations));",
  );
}
async function fulfill(order: string, quantity: number, location = L) {
  const l = await db
    .from("order_lines")
    .select("id")
    .eq("tenant_id", T)
    .eq("order_id", order)
    .single();
  if (l.error) throw new Error(l.error.message);
  return db.schema("fulfillments_private").rpc("record_fulfillment", {
    p_tenant_id: T,
    p_order_id: order,
    p_inventory_location_id: location,
    p_actor_membership_id: null,
    p_idempotency_key: `fulfill:${order}:${quantity}:${location}`,
    p_fulfilled_at: null,
    p_lines: [{ order_line_id: l.data.id, quantity }],
  });
}
describe.sequential("online commerce through real Next.js HTTP + PostgreSQL", () => {
  it("reads the published merged catalog and places one canonical guest order atomically", async () => {
    const published = await sdk.getPublishedProduct({ tenantId: T, slug: "pos-tee" });
    expect(published.variants[0]?.id).toBe(V);
    const result = CheckoutResultSchema.parse(await checkout("runtime-first", 2));
    expect(result).toMatchObject({
      channel: "online",
      status: "placed",
      totalMinor: 5000,
      payment: { status: "pending", method: "cash_on_delivery" },
      fulfillmentStatus: "unfulfilled",
    });
    expect(await counts()).toBe("[1, 1, 1, 1, 1, 1]");
    expect(
      sql(
        `select on_hand_quantity from inventory_balances where variant_id='${V}' and inventory_location_id='${L}'`,
      ),
    ).toBe("10");
    expect(sql("select normalized_email||'|'||normalized_phone from customers")).toBe(
      "guest@example.com|+201001234567",
    );
  }, 60000);
  it("management list/detail sees online channel, snapshots, pending payment and stock commitment", async () => {
    const id = await orderFor("runtime-first");
    const list = await management.withTenant(T).listOrders({ channel: "online" });
    expect(JSON.stringify(list)).toContain(id);
    const detail = OrderDetailResponseSchema.parse(await management.withTenant(T).getOrder(id));
    expect(detail.commerce).toMatchObject({
      customer: intent.customer,
      delivery: intent.delivery,
      payment: { status: "pending" },
      reservations: [
        { quantity: 2, consumedQuantity: 0, status: "active", inventoryLocationId: L },
      ],
    });
    expect(detail.fulfillmentProgress.status).toBe("unfulfilled");
    await expect(management.withTenant(foreignT).getOrder(id)).rejects.toBeInstanceOf(ApiHttpError);
  }, 60000);
  it("exact replay has no duplicate artifacts; changed contact with the same key conflicts", async () => {
    const before = await counts();
    const first = await checkout("runtime-first", 2);
    expect(await checkout("runtime-first", 2)).toEqual(first);
    await expect(
      sdk.checkout({
        ...intent,
        customer: { ...intent.customer, name: "Changed" },
        idempotencyKey: "runtime-first",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(await counts()).toBe(before);
  });
  it("rejects a stale current price and currency before any business mutation", async () => {
    const before = await counts();
    await expect(
      sdk.checkout({ ...intent, expectedTotalMinor: 2400, idempotencyKey: "stale" }),
    ).rejects.toMatchObject({ code: "PRICE_CHANGED", details: [{ value: 2500 }] });
    await expect(
      sdk.checkout({ ...intent, expectedCurrency: "EGP", idempotencyKey: "wrong-currency" }),
    ).rejects.toMatchObject({ code: "CURRENCY_CHANGED" });
    expect(await counts()).toBe(before);
  });
  it("uses replaced current catalog prices while preserving replay snapshots", async () => {
    sql(
      `set role service_role; select catalog_private.set_variant_price('${T}','${V}','USD',2600,'price-change-proof');`,
    );
    try {
      await expect(checkout("real-price-change")).rejects.toMatchObject({
        code: "PRICE_CHANGED",
        details: [{ value: 2600 }],
      });
      expect((await checkout("runtime-first", 2)).totalMinor).toBe(5000);
    } finally {
      sql(
        `set role service_role; select catalog_private.set_variant_price('${T}','${V}','USD',2500,'price-restore-proof');`,
      );
    }
  });
  it("rejects foreign tenant/brand and unconfigured storefronts without artifacts", async () => {
    const before = await counts();
    await expect(
      sdk.checkout({ ...intent, tenantId: foreignT, idempotencyKey: "foreign" }),
    ).rejects.toMatchObject({ code: "CHECKOUT_UNAVAILABLE" });
    await expect(
      sdk.checkout({
        ...intent,
        brandId: "2a000002-0000-4000-8000-000000000002",
        idempotencyKey: "wrong-brand",
      }),
    ).rejects.toMatchObject({ code: "VARIANT_NOT_SELLABLE" });
    expect(await counts()).toBe(before);
  });
  it("enforces publication and active variants, yet replays accepted intent after catalog change", async () => {
    sql(
      `update products set storefront_status='unpublished',storefront_published_at=null where id='${P}';`,
    );
    try {
      await expect(checkout("unpublished")).rejects.toMatchObject({ code: "VARIANT_NOT_SELLABLE" });
      expect((await checkout("runtime-first", 2)).totalMinor).toBe(5000);
    } finally {
      sql(
        `update products set storefront_status='published',storefront_published_at=now() where id='${P}';`,
      );
    }
    sql(`update product_variants set status='draft' where id='${V}'`);
    try {
      await expect(checkout("draft-variant")).rejects.toMatchObject({
        code: "VARIANT_NOT_SELLABLE",
      });
    } finally {
      sql(`update product_variants set status='active' where id='${V}'`);
    }
  });
  it("rejects insufficient ATS and prevents every physical write from spending held stock", async () => {
    await expect(checkout("too-many", 9)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(() =>
      sql(
        `set role service_role; select inventory_private.record_operation('${T}','issue','[{"variant_id":"${V}","inventory_location_id":"${L}","quantity_delta":-9}]',null,'steal',null,null);`,
      ),
    ).toThrow(/committed/);
    expect(
      sql(
        `select on_hand_quantity from inventory_balances where variant_id='${V}' and inventory_location_id='${L}'`,
      ),
    ).toBe("10");
  });
  it("snapshots survive mutable customer edits and matching unverified contacts never merge", async () => {
    sql(
      "set role online_writer; update customers set name='Edited later',updated_at=now(); update customer_addresses set address=jsonb_set(address,'{city}','\"Alexandria\"'),updated_at=now();",
    );
    const detail = await management.withTenant(T).getOrder(await orderFor("runtime-first"));
    expect(detail.commerce?.customer?.name).toBe("Guest");
    expect(detail.commerce?.delivery?.city).toBe("Cairo");
    await checkout("same-contact");
    expect(sql("select count(*) from customers")).toBe("2");
    await cancel(await orderFor("same-contact"));
  });
  it("cancellation releases commitments and pending payment exactly once", async () => {
    const id = await orderFor("runtime-first");
    await cancel(id);
    await cancel(id);
    const detail = await management.withTenant(T).getOrder(id);
    expect(detail.header.status).toBe("cancelled");
    expect(detail.commerce?.reservations[0]?.status).toBe("released");
    expect(detail.commerce?.payment?.status).toBe("cancelled");
    expect((await checkout("runtime-first", 2)).status).toBe("placed"); // immutable placement receipt
  });
  it("consumes partial then full reservations with canonical issues; wrong-location failure is atomic", async () => {
    await checkout("fulfillment", 3);
    const id = await orderFor("fulfillment");
    expect((await fulfill(id, 1, "2a000004-0000-4000-8000-000000000002")).error).not.toBeNull();
    sql(
      "create function public.fail_fulfillment_test() returns trigger language plpgsql as $$begin raise exception 'injected after stock issue'; end$$; create trigger fail_fulfillment_test before insert on fulfillment_lines for each row execute function public.fail_fulfillment_test();",
    );
    try {
      expect((await fulfill(id, 1)).error).not.toBeNull();
    } finally {
      sql(
        "drop trigger fail_fulfillment_test on fulfillment_lines; drop function public.fail_fulfillment_test();",
      );
    }
    expect(sql(`select consumed_quantity from stock_reservations where order_id='${id}'`)).toBe(
      "0",
    );
    expect(
      sql(
        `select on_hand_quantity from inventory_balances where variant_id='${V}' and inventory_location_id='${L}'`,
      ),
    ).toBe("10");
    expect((await fulfill(id, 1)).error).toBeNull();
    let detail = await management.withTenant(T).getOrder(id);
    expect(detail.commerce?.reservations[0]).toMatchObject({
      status: "active",
      consumedQuantity: 1,
    });
    expect(detail.fulfillmentProgress.status).toBe("partially_fulfilled");
    expect((await fulfill(id, 2)).error).toBeNull();
    detail = await management.withTenant(T).getOrder(id);
    expect(detail.commerce?.reservations[0]).toMatchObject({
      status: "consumed",
      consumedQuantity: 3,
    });
    expect(detail.fulfillmentProgress.status).toBe("fulfilled");
    await expect(cancel(id)).rejects.toThrow(/fulfillment/i);
    expect(
      sql(
        `select on_hand_quantity from inventory_balances where variant_id='${V}' and inventory_location_id='${L}'`,
      ),
    ).toBe("7");
  });
  it("expiry explicitly cancels/releases and rejects later fulfillment", async () => {
    await checkout("expiry");
    const id = await orderFor("expiry");
    sql(
      `set role online_writer; update stock_reservations set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where order_id='${id}';`,
    );
    expect((await fulfill(id, 1)).error).not.toBeNull();
    const args = { p_tenant: T, p_order: id };
    expect((await db.schema("online_private").rpc("expire_reservations", args)).data).toBe(true);
    expect((await db.schema("online_private").rpc("expire_reservations", args)).data).toBe(false);
    expect(sql(`select status from stock_reservations where order_id='${id}'`)).toBe("expired");
    expect((await fulfill(id, 1)).error).not.toBeNull();
  });
  it("rolls back Customer, Order, number, reservation and Payment when failure occurs at the last write", async () => {
    const before = await counts();
    const sequence = sql("select next_value from order_number_sequences");
    sql(
      "create function public.fail_checkout_test() returns trigger language plpgsql as $$begin raise exception 'injected end-of-transaction failure'; end$$; create trigger fail_checkout_test before insert on checkout_operations for each row execute function public.fail_checkout_test();",
    );
    try {
      await expect(checkout("rollback")).rejects.toMatchObject({ status: 500 });
    } finally {
      sql(
        "drop trigger fail_checkout_test on checkout_operations; drop function public.fail_checkout_test();",
      );
    }
    expect(await counts()).toBe(before);
    expect(sql("select next_value from order_number_sequences")).toBe(sequence);
    await checkout("rollback");
    await cancel(await orderFor("rollback"));
  });
  it("two simultaneous last-unit checkouts cannot both win; public availability follows ATS", async () => {
    await checkout("hold-six", 6);
    const outcomes = await Promise.allSettled([checkout("last-a"), checkout("last-b")]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((r) => r.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });
    expect(
      (await sdk.getPublishedProduct({ tenantId: T, slug: "pos-tee" })).variants[0]?.inStock,
    ).toBe(false);
    await cancel(await orderFor(outcomes[0]?.status === "fulfilled" ? "last-a" : "last-b"));
    await cancel(await orderFor("hold-six"));
  });
  it("simultaneous same-key retries create exactly one aggregate", async () => {
    const before = Number(sql("select count(*) from orders"));
    const [a, b] = await Promise.all([checkout("parallel-replay"), checkout("parallel-replay")]);
    expect(a).toEqual(b);
    expect(Number(sql("select count(*) from orders"))).toBe(before + 1);
    await cancel(await orderFor("parallel-replay"));
  });
  it("denies all direct customer/reservation data access and writes to public roles; tenant FKs hold", () => {
    for (const role of ["anon", "authenticated"])
      for (const table of [
        "customers",
        "customer_addresses",
        "stock_reservations",
        "checkout_operations",
        "storefront_checkout_settings",
      ]) {
        expect(() => sql(`set role ${role}; select * from ${table};`)).toThrow(/permission denied/);
      }
    for (const table of [
      "customers",
      "customer_addresses",
      "stock_reservations",
      "checkout_operations",
    ]) {
      expect(() => sql(`set role service_role; delete from ${table};`)).toThrow(
        /permission denied/,
      );
    }
    expect(() =>
      sql("set role anon; select online_private.place_checkout('attack','{}');"),
    ).toThrow(/permission denied/);
    expect(
      sql(
        "select count(*) from pg_class where relname in ('customers','customer_addresses','stock_reservations','checkout_operations','storefront_checkout_settings') and relrowsecurity",
      ),
    ).toBe("5");
    const customer = sql("select id from customers limit 1");
    expect(() =>
      sql(
        `set role online_writer; insert into customer_addresses(tenant_id,customer_id,address) values('${foreignT}','${customer}','{}');`,
      ),
    ).toThrow(/foreign key/);
    expect(sql("select count(*) from inventory_balances where on_hand_quantity<0")).toBe("0");
  });
  it("guards the provider-neutral payment lifecycle and preserves amount/currency", async () => {
    await checkout("payment-lifecycle");
    const id = await orderFor("payment-lifecycle");
    sql(
      `set role payments_writer; select payments_private.transition_payment('${T}','${id}','authorized'); select payments_private.transition_payment('${T}','${id}','captured'); select payments_private.transition_payment('${T}','${id}','captured');`,
    );
    expect(
      sql(`select status||'|'||amount_minor||'|'||currency from payments where order_id='${id}'`),
    ).toBe("captured|2500|USD");
    expect(() =>
      sql(
        `set role payments_writer; select payments_private.transition_payment('${T}','${id}','failed');`,
      ),
    ).toThrow(/invalid payment transition/);
    await expect(cancel(id)).rejects.toThrow(/invalid payment transition/);
    expect(sql(`select status from stock_reservations where order_id='${id}'`)).toBe("active");
  });
  it("public HTTP rejects injected authority, absent keys and malformed JSON", async () => {
    for (const body of [
      { ...intent, inventoryLocationId: L },
      { ...intent, lines: [{ variantId: V, quantity: 1, unitPriceMinor: 1 }] },
    ]) {
      const r = await fetch(`${url}/api/v1/storefront/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "injected" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
    expect(
      (
        await fetch(`${url}/api/v1/storefront/checkout`, {
          method: "POST",
          body: JSON.stringify(intent),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/storefront/checkout`, {
          method: "POST",
          headers: { "Idempotency-Key": "bad-json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
  });
});
