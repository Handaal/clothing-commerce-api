import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationService } from "../../src/authorization/authorization-service";
import { AuthorizationError } from "../../src/authorization/errors";
import type { VerifiedExternalIdentity } from "../../src/authorization/model";
import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import {
  CreatePosSaleRequestSchema,
  CreatePosSaleResponseSchema,
  PosContextResponseSchema,
  RecordCustomerPaymentRequestSchema,
  RecordCustomerPaymentResponseSchema,
  CustomerDuesResponseSchema,
} from "../../src/contracts";
import { CustomersArService, createSupabaseCustomersArRepository } from "../../src/customers";
import { CustomerPathSchema } from "../../src/management/request";
import { FulfillmentService } from "../../src/fulfillments/fulfillment-service";
import { createSupabaseFulfillmentRepository } from "../../src/fulfillments/supabase-fulfillment-repository";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../src/http/management-route";
import { OrdersReadService } from "../../src/orders/orders-read-service";
import { OrderService } from "../../src/orders/order-service";
import { createSupabaseOrdersReadRepository } from "../../src/orders/supabase-orders-read-repository";
import { createSupabaseOrdersRepository } from "../../src/orders/supabase-orders-repository";
import { PosSaleService } from "../../src/pos/pos-sale-service";
import { createSupabasePosSaleRepository } from "../../src/pos/supabase-pos-sale-repository";

const url = process.env.POS_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.POS_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("POS_TEST_SUPABASE_URL and POS_TEST_SUPABASE_SERVICE_ROLE_KEY are required.");
}
const config = { url, serviceRoleKey };
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

const TENANT = "2a000001-0000-4000-8000-000000000001";
const FOREIGN_TENANT = "2a000001-0000-4000-8000-000000000002";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const LOCATION = "2a000004-0000-4000-8000-000000000001";
const VARIANT = "2a000007-0000-4000-8000-000000000001";
const ACTOR = "2a000012-0000-4000-8000-000000000001";

class FakeVerifier implements ExternalIdentityVerifier {
  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    const match = request.headers.get("Authorization")?.match(/^Bearer subject:(.+)$/);
    if (!match) throw new AuthorizationError("UNAUTHENTICATED");
    return { provider: "clerk", subject: match[1] as string };
  }
}

let resolver: AuthorizationContextResolver;
let sales: PosSaleService;
let managementOrders: OrdersReadService;
let customersAr: CustomersArService;

beforeAll(async () => {
  const { createSupabaseAuthorizationRepository } =
    await import("../../src/authorization/supabase-authorization-repository");
  const authorizationRepository = createSupabaseAuthorizationRepository(config);
  resolver = new AuthorizationContextResolver(new FakeVerifier(), authorizationRepository);
  const authorization = new AuthorizationService(authorizationRepository);
  const orderRepository = createSupabaseOrdersRepository(config);
  sales = new PosSaleService(
    authorization,
    createSupabasePosSaleRepository(config),
    orderRepository,
  );
  managementOrders = new OrdersReadService(
    createSupabaseOrdersReadRepository(config),
    new OrderService(authorization, orderRepository),
    new FulfillmentService(authorization, createSupabaseFulfillmentRepository(config)),
  );
  customersAr = new CustomersArService(authorization, createSupabaseCustomersArRepository(config));
});

function httpRequest(
  subject: string | null,
  tenantId: string,
  path: string,
  options: { key?: string; body?: unknown; origin?: string } = {},
): Request {
  const headers = new Headers({ "X-Tenant-Id": tenantId });
  if (subject !== null) headers.set("Authorization", `Bearer subject:${subject}`);
  if (options.key !== undefined) headers.set("Idempotency-Key", options.key);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.origin !== undefined) headers.set("Origin", options.origin);
  return new Request(`http://test${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function saleBody(quantity = 2, expectedTotalMinor = quantity * 2500, cash = 6000) {
  return {
    registerId: REGISTER,
    expectedTotalMinor,
    cashReceivedMinor: cash,
    lines: [{ variantId: VARIANT, quantity }],
  };
}

async function postSale(
  subject: string | null,
  key: string,
  body: ReturnType<typeof saleBody>,
  tenantId = TENANT,
) {
  const request = httpRequest(subject, tenantId, "/api/v1/pos/sales", { key, body });
  return runTenantManagementWriteRoute({
    request,
    contextResolver: resolver,
    requestSchema: CreatePosSaleRequestSchema,
    responseSchema: CreatePosSaleResponseSchema,
    handler: ({ context, body: parsed, idempotencyKey }) =>
      sales.createSale(context, parsed, idempotencyKey),
  });
}

async function getContext(subject: string) {
  const request = httpRequest(subject, TENANT, "/api/v1/pos/context");
  return runTenantManagementRoute({
    request,
    contextResolver: resolver,
    responseSchema: PosContextResponseSchema,
    handler: (context) => sales.getContext(context),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// --- Installment (customer A/R) helpers ---

async function postCustomerPayment(
  subject: string,
  customerId: string,
  key: string,
  body: { amountMinor: number; notes?: string | null },
) {
  const request = httpRequest(subject, TENANT, `/api/v1/customers/${customerId}/payments`, {
    key,
    body,
  });
  return runTenantManagementWriteRoute({
    request,
    contextResolver: resolver,
    requestSchema: RecordCustomerPaymentRequestSchema,
    responseSchema: RecordCustomerPaymentResponseSchema,
    handler: ({ context, body: parsed, idempotencyKey }) =>
      customersAr.recordPayment(
        context,
        CustomerPathSchema.parse({ customerId }).customerId,
        idempotencyKey,
        parsed,
      ),
  });
}

async function getDues(subject: string) {
  const request = httpRequest(subject, TENANT, "/api/v1/customers/dues");
  return runTenantManagementRoute({
    request,
    contextResolver: resolver,
    responseSchema: CustomerDuesResponseSchema,
    handler: (context) => customersAr.dues(context),
  });
}

// Authoritative outstanding straight from the ledger (Σ owed − Σ paid), for cross-checking responses.
async function outstanding(customerId: string): Promise<number> {
  const [debts, payments] = await Promise.all([
    admin
      .from("customer_sale_debts")
      .select("total_minor,initial_paid_minor")
      .eq("tenant_id", TENANT)
      .eq("customer_id", customerId),
    admin
      .from("customer_payments")
      .select("amount_minor")
      .eq("tenant_id", TENANT)
      .eq("customer_id", customerId),
  ]);
  if (debts.error) throw new Error(debts.error.message);
  if (payments.error) throw new Error(payments.error.message);
  const owed = (debts.data as { total_minor: number; initial_paid_minor: number }[]).reduce(
    (sum, row) => sum + (Number(row.total_minor) - Number(row.initial_paid_minor)),
    0,
  );
  const paid = (payments.data as { amount_minor: number }[]).reduce(
    (sum, row) => sum + Number(row.amount_minor),
    0,
  );
  return Math.max(0, owed - paid);
}

async function state() {
  const [orders, payments, fulfillments, salesRows, balance] = await Promise.all([
    admin.from("orders").select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
    admin.from("payments").select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
    admin.from("fulfillments").select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
    admin.from("pos_sales").select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
    admin
      .from("inventory_balances")
      .select("on_hand_quantity")
      .eq("tenant_id", TENANT)
      .eq("variant_id", VARIANT)
      .eq("inventory_location_id", LOCATION)
      .single(),
  ]);
  for (const result of [orders, payments, fulfillments, salesRows, balance]) {
    if (result.error) throw new Error(result.error.message);
  }
  return {
    orders: orders.count ?? 0,
    payments: payments.count ?? 0,
    fulfillments: fulfillments.count ?? 0,
    sales: salesRows.count ?? 0,
    stock: Number((balance.data as { on_hand_quantity: number | string }).on_hand_quantity),
  };
}

describe.sequential("Connected POS Sale V1 real HTTP boundary", () => {
  let successful: Record<string, unknown>;

  it("returns only fully authorized active register selling context", async () => {
    const settingsSave = await admin.schema("settings_private").rpc("write_register", {
      p_tenant: TENANT,
      p_register: REGISTER,
      p_actor: ACTOR,
      p_key: "pos-context-topology-save",
      p_input: {
        status: "active",
        defaultInventoryLocationId: LOCATION,
      },
    });
    expect(settingsSave.error).toBeNull();

    const response = await getContext("pos-full");
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      // Phase 2R enriched /pos/context with server-owned receipt identity: a top-level
      // business.tenant block and a per-register branch identity. These are additive; every
      // pre-existing register field below is unchanged. The seed leaves the new identity
      // columns unset, so they resolve to null.
      business: {
        tenant: {
          displayName: "POS Test",
          legalName: null,
          taxIdentifier: null,
        },
      },
      registers: [
        {
          registerId: REGISTER,
          registerName: "Front Register",
          branchId: "2a000003-0000-4000-8000-000000000001",
          branchName: "Main Branch",
          defaultInventoryLocationId: LOCATION,
          defaultInventoryLocationName: "Selling Floor",
          sellingCurrency: "USD",
          canSell: true,
          branch: {
            displayName: "Main Branch",
            addressLine1: null,
            addressLine2: null,
            city: null,
            region: null,
            postalCode: null,
            countryCode: null,
            contactEmail: null,
            contactPhone: null,
            receiptFooter: null,
          },
        },
      ],
    });
    // Business identity is server-owned and returned regardless of register eligibility;
    // only the register list narrows to empty for an operator who cannot sell.
    const denied = await getContext("pos-no-payment");
    expect(await json(denied)).toEqual({
      business: {
        tenant: {
          displayName: "POS Test",
          legalName: null,
          taxIdentifier: null,
        },
      },
      registers: [],
    });
  });

  it("atomically creates order, cash payment, full fulfillment, and stock issue", async () => {
    const response = await postSale("pos-full", "sale-success", saleBody());
    expect(response.status).toBe(200);
    successful = await json(response);
    expect(successful).toMatchObject({
      saleStatus: "completed",
      order: { channel: "pos", status: "placed", totalMinor: 5000, currency: "USD" },
      payment: {
        method: "cash",
        status: "captured",
        amountMinor: 5000,
        cashReceivedMinor: 6000,
        changeMinor: 1000,
      },
      fulfillment: { inventoryLocationId: LOCATION },
    });
    expect(await state()).toEqual({
      orders: 1,
      payments: 1,
      fulfillments: 1,
      sales: 1,
      stock: 8,
    });
  });

  it("replays the whole sale without a second component or issue", async () => {
    const response = await postSale("pos-full", "sale-success", saleBody());
    expect(response.status).toBe(200);
    const replay = await json(response);
    expect((replay.order as Record<string, unknown>).id).toBe(
      (successful.order as Record<string, unknown>).id,
    );
    expect((replay.payment as Record<string, unknown>).id).toBe(
      (successful.payment as Record<string, unknown>).id,
    );
    expect((replay.fulfillment as Record<string, unknown>).id).toBe(
      (successful.fulfillment as Record<string, unknown>).id,
    );
    expect((await state()).stock).toBe(8);
  });

  it("rejects a changed same-key request", async () => {
    const response = await postSale("pos-full", "sale-success", saleBody(3, 7500, 8000));
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("rolls every component back on insufficient stock", async () => {
    const before = await state();
    const response = await postSale("pos-full", "sale-low-stock", saleBody(20, 50000, 50000));
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: { code: "INSUFFICIENT_STOCK" } });
    expect(await state()).toEqual(before);
  });

  it("returns structured PRICE_CHANGED before mutation", async () => {
    const before = await state();
    const response = await postSale("pos-full", "sale-price-change", saleBody(1, 2499, 3000));
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      error: {
        code: "PRICE_CHANGED",
        details: [{ path: ["expectedTotalMinor"], value: 2500 }],
      },
    });
    expect(await state()).toEqual(before);
  });

  it("rejects insufficient received cash before mutation", async () => {
    const before = await state();
    const response = await postSale("pos-full", "sale-short-cash", saleBody(1, 2500, 2499));
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ error: { code: "CASH_RECEIVED_INSUFFICIENT" } });
    expect(await state()).toEqual(before);
  });

  it.each([
    [null, TENANT, "auth-none", "UNAUTHENTICATED"],
    ["pos-full", FOREIGN_TENANT, "auth-tenant", "TENANT_ACCESS_DENIED"],
    ["pos-wrong-branch", TENANT, "auth-branch", "SCOPE_DENIED"],
    ["pos-wrong-location", TENANT, "auth-location", "SCOPE_DENIED"],
    ["pos-no-payment", TENANT, "auth-payment", "PERMISSION_DENIED"],
  ])("preauthorizes and makes no mutation for %s", async (subject, tenant, key, code) => {
    const before = await state();
    const response = await postSale(subject, key, saleBody(1, 2500, 3000), tenant);
    expect([401, 403]).toContain(response.status);
    expect(await json(response)).toMatchObject({ error: { code } });
    expect(await state()).toEqual(before);
  });

  it("shows the POS order and full fulfillment through existing management reads", async () => {
    const request = httpRequest("pos-full", TENANT, "/api/v1/orders");
    const context = await resolver.resolve({ request, requestedTenantId: TENANT });
    const orderId = (successful.order as Record<string, unknown>).id as string;
    const detail = await managementOrders.getOrder(context, orderId);
    expect(detail.header).toMatchObject({ channel: "pos", totalMinor: 5000 });
    expect(detail.lines[0]).toMatchObject({ quantity: 2, unitPriceMinor: 2500 });
    expect(detail.fulfillmentProgress).toMatchObject({ status: "fulfilled" });
  });

  it("allows POST and Idempotency-Key only for explicitly allowed origins", () => {
    const previous = process.env.COMMERCE_CORS_ALLOWED_ORIGINS;
    process.env.COMMERCE_CORS_ALLOWED_ORIGINS = "http://localhost:4173";
    try {
      const allowed = managementOptionsResponse(
        httpRequest("pos-full", TENANT, "/api/v1/pos/sales", {
          origin: "http://localhost:4173",
        }),
      );
      expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4173");
      expect(allowed.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      expect(allowed.headers.get("Access-Control-Allow-Headers")).toContain("Idempotency-Key");
      const denied = managementOptionsResponse(
        httpRequest("pos-full", TENANT, "/api/v1/pos/sales", {
          origin: "https://evil.example",
        }),
      );
      expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.COMMERCE_CORS_ALLOWED_ORIGINS;
      else process.env.COMMERCE_CORS_ALLOWED_ORIGINS = previous;
    }
  });
});

describe.sequential("Connected POS installment sale and customer A/R", () => {
  // A unique phone so the installment customer is created fresh (and is the only one carrying a debt).
  const CUSTOMER = { name: "Installment Buyer", phone: "+201000000111" };
  let customerId: string;

  function installmentBody(depositMinor: number, withCustomer = true) {
    // net = 2 × 2500 = 5000; the deposit is captured now and (net − deposit) becomes a debt.
    return {
      registerId: REGISTER,
      expectedTotalMinor: 5000,
      cashReceivedMinor: depositMinor,
      amountPaidMinor: depositMinor,
      lines: [{ variantId: VARIANT, quantity: 2 }],
      ...(withCustomer ? { customer: CUSTOMER } : {}),
    };
  }

  it("captures a partial deposit, fulfils the goods, and records the remainder as a customer debt", async () => {
    const before = await state();
    const response = await postSale("pos-full", "sale-installment", installmentBody(2000));
    expect(response.status).toBe(200);
    const receipt = await json(response);
    expect(receipt).toMatchObject({
      saleStatus: "completed",
      order: { channel: "pos", status: "placed", totalMinor: 5000, currency: "USD" },
      payment: { status: "captured", amountMinor: 2000 },
    });
    // Order, payment, fulfillment, and sale all committed; stock dropped by the full quantity sold.
    const after = await state();
    expect(after.orders).toBe(before.orders + 1);
    expect(after.payments).toBe(before.payments + 1);
    expect(after.fulfillments).toBe(before.fulfillments + 1);
    expect(after.sales).toBe(before.sales + 1);
    expect(after.stock).toBe(before.stock - 2);

    const debt = await admin
      .from("customer_sale_debts")
      .select("customer_id,total_minor,initial_paid_minor")
      .eq("tenant_id", TENANT)
      .eq("order_id", (receipt.order as Record<string, unknown>).id as string)
      .single();
    if (debt.error) throw new Error(debt.error.message);
    customerId = debt.data.customer_id as string;
    expect(Number(debt.data.total_minor)).toBe(5000);
    expect(Number(debt.data.initial_paid_minor)).toBe(2000);
    expect(await outstanding(customerId)).toBe(3000);
  });

  it("replays the installment sale with the same key without double-recording the debt", async () => {
    const response = await postSale("pos-full", "sale-installment", installmentBody(2000));
    expect(response.status).toBe(200);
    const debts = await admin
      .from("customer_sale_debts")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT)
      .eq("customer_id", customerId);
    if (debts.error) throw new Error(debts.error.message);
    expect(debts.count).toBe(1);
    expect(await outstanding(customerId)).toBe(3000);
  });

  it("rejects an installment deposit with no customer to carry the balance", async () => {
    const before = await state();
    const response = await postSale(
      "pos-full",
      "sale-installment-nocustomer",
      installmentBody(2000, false),
    );
    // Rejected at the contract boundary (the request schema requires a customer for a partial deposit).
    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  it("records a customer paydown and reduces the outstanding balance", async () => {
    const response = await postCustomerPayment("pos-full", customerId, "cust-pay-1", {
      amountMinor: 1000,
      notes: "Second visit",
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ amountMinor: 1000, outstandingMinor: 2000 });
    expect(await outstanding(customerId)).toBe(2000);
  });

  it("replays a paydown with the same key without charging twice", async () => {
    const response = await postCustomerPayment("pos-full", customerId, "cust-pay-1", {
      amountMinor: 1000,
      notes: "Second visit",
    });
    expect(response.status).toBe(200);
    expect(await outstanding(customerId)).toBe(2000);
  });

  it("rejects a paydown that exceeds the outstanding balance", async () => {
    const response = await postCustomerPayment("pos-full", customerId, "cust-pay-over", {
      amountMinor: 999_999,
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      error: { code: "PAYMENT_EXCEEDS_OUTSTANDING" },
    });
    expect(await outstanding(customerId)).toBe(2000);
  });

  it("lists the customer's remaining dues", async () => {
    const response = await getDues("pos-full");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customerId,
          purchasedMinor: 5000,
          paidMinor: 3000,
          outstandingMinor: 2000,
        }),
      ]),
    );
  });
});
