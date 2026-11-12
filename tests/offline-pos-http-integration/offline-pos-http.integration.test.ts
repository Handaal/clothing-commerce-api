// Phase 6B — FULL HTTP-SERVER-PATH offline-POS acceptance.
//
// Every request below leaves the test process over HTTP (loopback) to a REAL running Next.js API server
// and hits the real route/middleware/service/Supabase-RPC stack on an isolated disposable database. The
// client is the packed SDK (`createCommerceClient`), i.e. the same adapter the POS main process uses.
// Nothing here calls a route handler in-process. Only the external Clerk identity is provided via the
// server's standard CLERK_JWT_KEY env path (a test signing key, not a verifier override).
//
// Launched exclusively by `scripts/test-offline-pos-http-isolated.mjs`.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createCommerceClient, ApiHttpError } from "../../packages/sdk/src/index";
import {
  canonicalizeOfflineSaleCommand,
  canonicalizeOfflineCustomerPaymentCommand,
  canonicalizeOfflineAttendanceCommand,
  OfflineBootstrapResponseSchema,
  type OfflineBootstrapResponse,
  type OfflineSaleCommand,
  type OfflineCustomerPaymentCommand,
  type OfflineAttendanceCommand,
} from "../../src/contracts";

const baseUrl = process.env.POS_TEST_API_BASE_URL;
const clerkToken = process.env.POS_TEST_CLERK_TOKEN;
const supabaseUrl = process.env.POS_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.POS_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !clerkToken || !supabaseUrl || !serviceRoleKey)
  throw new Error("Phase 6B HTTP acceptance requires the isolated harness environment.");

const TENANT = "2a000001-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const REGISTER2 = "2a000005-0000-4000-8000-000000000002";
const VARIANT = "2a000007-0000-4000-8000-000000000001";
const CUSTOMER = "2a000030-0000-4000-8000-000000000001"; // Layla Hassan, outstanding 0 at seed

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

const deviceKeys = generateKeyPairSync("ed25519");
const devicePublicKey = deviceKeys.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

// Packed-SDK client against the running server, carrying the test Clerk session for management routes.
function makeClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
  return createCommerceClient({
    baseUrl: baseUrl!,
    getToken: async () => clerkToken!,
    fetch: fetchImpl,
  });
}
const tenant = makeClient().withTenant(TENANT);

async function httpStatusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiHttpError) return error.status;
    throw error;
  }
}
async function orderCount(): Promise<number> {
  const { count, error } = await admin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}
// Canonical stored tenders for an order, straight from the database (bypasses the HTTP response mapping),
// so a defect in the response layer can never make a card look like cash — we read what was persisted.
async function storedPayments(orderId: string): Promise<
  Array<{
    method: string;
    amountMinor: number;
    cashReceivedMinor: number | null;
    changeMinor: number | null;
  }>
> {
  const { data, error } = await admin
    .from("payments")
    .select("method,amount_minor,cash_received_minor,change_minor,tender_sequence")
    .eq("tenant_id", TENANT)
    .eq("order_id", orderId)
    .order("tender_sequence", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    method: String(row.method),
    amountMinor: Number(row.amount_minor),
    cashReceivedMinor: row.cash_received_minor == null ? null : Number(row.cash_received_minor),
    changeMinor: row.change_minor == null ? null : Number(row.change_minor),
  }));
}
// Canonical stored A/R debt for an installment order, straight from the database.
async function storedDebt(
  orderId: string,
): Promise<{ totalMinor: number; initialPaidMinor: number } | null> {
  const { data, error } = await admin
    .from("customer_sale_debts")
    .select("total_minor,initial_paid_minor")
    .eq("tenant_id", TENANT)
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { totalMinor: Number(data.total_minor), initialPaidMinor: Number(data.initial_paid_minor) }
    : null;
}

let grant: OfflineBootstrapResponse;
let credentialId: string;
let deviceId: string;
let ordinal = 0;
let cumulative = 0;

function unitPrice(): number {
  const variant = grant.catalog.flatMap((p) => p.variants).find((v) => v.variantId === VARIANT)!;
  return variant.authorizedUnitPriceMinor;
}
function priceId(): string {
  return grant.catalog.flatMap((p) => p.variants).find((v) => v.variantId === VARIANT)!.priceId;
}
// Build the next cash sale command, advancing the durable ordinal + cumulative exposure like the device would.
function saleCommand(overrides: Partial<OfflineSaleCommand> = {}): OfflineSaleCommand {
  const quantity = overrides.lines?.[0]?.quantity ?? 1;
  const total = quantity * unitPrice();
  ordinal += 1;
  cumulative += total;
  const id = randomUUID();
  return {
    schemaVersion: 1,
    localSaleId: `http-${id}`,
    syncCommandId: id,
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    registerId: grant.registerId,
    acceptedAt: new Date().toISOString(),
    currency: grant.currency,
    lines: [
      { variantId: VARIANT, quantity, grantedUnitPriceMinor: unitPrice(), priceId: priceId() },
    ],
    totalMinor: total,
    cashReceivedMinor: total + 100,
    changeMinor: 100,
    offlineSaleOrdinal: ordinal,
    cumulativeExposureMinor: cumulative,
    ...overrides,
  };
}
function signSale(command: OfflineSaleCommand, privateKey = deviceKeys.privateKey) {
  return {
    command,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(null, Buffer.from(canonicalizeOfflineSaleCommand(command)), privateKey).toString(
        "base64",
      ),
    },
  };
}
function signPayment(command: OfflineCustomerPaymentCommand) {
  return {
    command,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(
        null,
        Buffer.from(canonicalizeOfflineCustomerPaymentCommand(command)),
        deviceKeys.privateKey,
      ).toString("base64"),
    },
  };
}
function ingestSale(payload: ReturnType<typeof signSale>) {
  return tenant.ingestOfflineSale({ idempotencyKey: payload.command.syncCommandId, ...payload });
}

beforeAll(async () => {
  const enrolled = await tenant.enrollPosDevice({
    idempotencyKey: `http-enroll-${randomUUID()}`,
    registerId: REGISTER,
    installationId: "http-main",
    displayName: "http-main",
    publicKey: { algorithm: "Ed25519", encoding: "spki_der_base64", value: devicePublicKey },
    clientVersion: "0.5.0",
  });
  deviceId = enrolled.deviceId;
  credentialId = enrolled.credentialId;
  grant = OfflineBootstrapResponseSchema.parse(
    await tenant.createOfflineBootstrap({
      idempotencyKey: `http-grant-${randomUUID()}`,
      deviceId,
      registerId: REGISTER,
    }),
  );
});

describe.sequential("Phase 6B offline POS over the real HTTP server", () => {
  it("case 1 — commit then lost response: retry replays exactly once; changed intent conflicts", async () => {
    const payload = signSale(saleCommand());
    const before = await orderCount();

    // Fault injector: forward the real request over the wire (server commits), then DROP the response.
    let dropped = false;
    const faultFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!dropped && url.includes("/pos/offline-sales")) {
        dropped = true;
        await response.text(); // let the server finish writing the committed response
        throw new Error("simulated lost response after server commit");
      }
      return response;
    };
    const faultTenant = makeClient(faultFetch).withTenant(TENANT);
    await expect(ingestSaleWith(faultTenant, payload)).rejects.toThrow(); // client sees a network failure
    expect(dropped).toBe(true);
    expect(await orderCount()).toBe(before + 1); // the server DID commit exactly one order

    // The device retries the exact saved command (same id/signature/idempotency key) over a healthy client.
    const replay = await ingestSale(payload);
    expect(replay.syncStatus).toBe("synced");
    expect(await orderCount()).toBe(before + 1); // still exactly one — idempotent, no duplicate

    // Changed intent reusing the same idempotency key is rejected.
    // Reuses the same syncCommandId with changed intent → 409 (does not consume a new ordinal).
    const conflict = signSale({
      ...payload.command,
      totalMinor: payload.command.totalMinor - 1,
      changeMinor: 101,
    });
    expect(await httpStatusOf(ingestSale(conflict))).toBe(409);
  });

  // D-1 regression: the offline installment-sale happy path over the real HTTP server. Previously returned
  // HTTP 500 from record_offline_sale's installment branch. Asserts the DEPOSIT is captured now, the debt
  // is recorded in the database, exact replay is idempotent, and a later paydown reduces the balance.
  it("case 3 — installment sale then balance-reducing paydown, each idempotent (DB-verified)", async () => {
    const total = unitPrice();
    const deposit = 1000;
    const base = saleCommand();
    const installment = signSale({
      ...base,
      cashReceivedMinor: deposit + 100,
      changeMinor: 100,
      customerId: CUSTOMER,
      amountPaidMinor: deposit,
      outstandingMinor: total - deposit,
    });
    const sale = await ingestSale(installment);
    expect(sale.syncStatus).toBe("synced");
    expect(sale.order.totalMinor).toBe(total);
    expect(sale.payment.amountMinor).toBe(deposit); // only the deposit is captured now
    expect(sale.payment.method).toBe("cash");
    // Canonical DB state: the deposit is captured and the remainder is a recorded customer debt.
    expect(await storedPayments(sale.order.id)).toEqual([
      { method: "cash", amountMinor: deposit, cashReceivedMinor: deposit + 100, changeMinor: 100 },
    ]);
    expect(await storedDebt(sale.order.id)).toEqual({
      totalMinor: total,
      initialPaidMinor: deposit,
    });

    const replaySale = await ingestSale(installment);
    expect(replaySale.ingestionId).toBe(sale.ingestionId); // idempotent, no second debt
    expect(await storedDebt(sale.order.id)).toEqual({
      totalMinor: total,
      initialPaidMinor: deposit,
    });

    // Pay down 500 of the 1500 outstanding → new balance 1000.
    const payCommand: OfflineCustomerPaymentCommand = {
      schemaVersion: 1,
      localPaymentId: `pay-${randomUUID()}`,
      syncCommandId: randomUUID(),
      grantId: grant.grantId,
      deviceId: grant.deviceId,
      registerId: grant.registerId,
      acceptedAt: new Date().toISOString(),
      currency: grant.currency,
      customerId: CUSTOMER,
      amountMinor: 500,
    };
    const payload = signPayment(payCommand);
    const paid = await tenant.ingestOfflineCustomerPayment({
      idempotencyKey: payCommand.syncCommandId,
      ...payload,
    });
    expect(paid.syncStatus).toBe("synced");
    expect(paid.payment.amountMinor).toBe(500);
    expect(paid.payment.outstandingMinor).toBe(total - deposit - 500); // 1500 - 500 = 1000
    const replayPaid = await tenant.ingestOfflineCustomerPayment({
      idempotencyKey: payCommand.syncCommandId,
      ...payload,
    });
    expect(replayPaid.ingestionId).toBe(paid.ingestionId); // idempotent, balance not reduced twice
  });

  it("case 3b — installment with an unknown customer is rejected fail-closed", async () => {
    const total = unitPrice();
    const deposit = 1000;
    const before = await orderCount();
    const cmd = signSale({
      ...saleCommand(),
      cashReceivedMinor: deposit + 100,
      changeMinor: 100,
      customerId: "2a000030-0000-4000-8000-0000000000ff", // not a seeded customer
      amountPaidMinor: deposit,
      outstandingMinor: total - deposit,
    });
    expect(await httpStatusOf(ingestSale(cmd))).toBeGreaterThanOrEqual(400);
    expect(await orderCount()).toBe(before); // no partial write
    ordinal -= 1;
    cumulative -= total;
  });

  // D-2 regression: a card-only offline tender is recorded with its TRUE method, verified against the DB
  // (not just the HTTP response). "Recorded" is a cashier-attested capture — NOT a gateway settlement; no
  // provider capture is implied. Per capture_payments, a non-cash tender stores cash_received = amount and
  // change = 0 (an exact capture), so those are asserted as the canonical stored values.
  it("case 4 — card-only offline tender is stored and reported as a card capture (DB-verified)", async () => {
    const total = unitPrice();
    const cmd = saleCommand({
      cashReceivedMinor: 0,
      changeMinor: 0,
      tenders: [{ method: "card", amountMinor: total }],
    });
    const result = await ingestSale(signSale(cmd));
    expect(result.syncStatus).toBe("synced");
    // HTTP response preserves the method.
    const payments = result.payments ?? [result.payment];
    const card = payments.find((p) => p.method === "card")!;
    expect(card).toBeDefined();
    expect(card.status).toBe("captured");
    expect(card.amountMinor).toBe(total);
    expect(result.payment.method).toBe("card"); // primary of a card-only sale is the card
    // Canonical DB truth: exactly one payment, method card, amount = total (no silent cash fallback).
    expect(await storedPayments(result.order.id)).toEqual([
      { method: "card", amountMinor: total, cashReceivedMinor: total, changeMinor: 0 },
    ]);
  });

  it("case 6 — cash + card split offline tender preserves both legs (DB-verified)", async () => {
    const total = unitPrice();
    const cashLeg = 1000;
    const cardLeg = total - cashLeg;
    const cmd = saleCommand({
      cashReceivedMinor: cashLeg + 100,
      changeMinor: 100,
      tenders: [
        { method: "cash", amountMinor: cashLeg, cashReceivedMinor: cashLeg + 100 },
        { method: "card", amountMinor: cardLeg },
      ],
    });
    const result = await ingestSale(signSale(cmd));
    expect(result.syncStatus).toBe("synced");
    const payments = result.payments ?? [result.payment];
    expect(payments.find((p) => p.method === "cash")?.amountMinor).toBe(cashLeg);
    expect(payments.find((p) => p.method === "card")?.amountMinor).toBe(cardLeg);
    expect(result.payment.method).toBe("cash"); // the primary of a split is the cash leg
    // Canonical DB truth: two distinct tenders summing to the total, each with its real method/amount.
    expect(await storedPayments(result.order.id)).toEqual([
      { method: "cash", amountMinor: cashLeg, cashReceivedMinor: cashLeg + 100, changeMinor: 100 },
      { method: "card", amountMinor: cardLeg, cashReceivedMinor: cardLeg, changeMinor: 0 },
    ]);
  });

  it("case 7 — a tender list that does not sum to the total fails closed (no write)", async () => {
    const total = unitPrice();
    const before = await orderCount();
    const good = saleCommand({ cashReceivedMinor: 0, changeMinor: 0 });
    // Bypass client-side schema validation to submit a malformed tender sum straight over HTTP.
    const payload = signSale({ ...good, tenders: [{ method: "card", amountMinor: total }] });
    const body = JSON.parse(JSON.stringify(payload));
    body.command.tenders = [{ method: "card", amountMinor: total - 1 }]; // no longer sums to total
    const response = await globalThis.fetch(`${baseUrl}/api/v1/pos/offline-sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Id": TENANT,
        "Idempotency-Key": good.syncCommandId,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await orderCount()).toBe(before); // fail-closed: never silently fell back to cash
    ordinal -= 1;
    cumulative -= total;
  });

  it("case 5 — unsupported schema/contract version is rejected fail-closed with no writes", async () => {
    const before = await orderCount();
    const good = saleCommand();
    const payload = signSale(good);
    // Bypass the client types to submit an unsupported command version straight over HTTP.
    const body = JSON.parse(JSON.stringify(payload));
    body.command.schemaVersion = 2;
    const response = await globalThis.fetch(`${baseUrl}/api/v1/pos/offline-sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Id": TENANT,
        "Idempotency-Key": good.syncCommandId,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await orderCount()).toBe(before); // fail-closed: nothing persisted
    // this rejected command never advanced server state; rewind local counters
    ordinal -= 1;
    cumulative -= good.totalMinor;
  });

  it("case 2 — a second concurrent device on the same stock location is refused by the grant lock", async () => {
    // The approved contract (issue_grant per-location advisory lock) allows exactly one active offline
    // device per inventory location, which is the concurrency guarantee. Enroll a distinct device on a
    // register sharing REGISTER's location and prove its bootstrap is refused (409) while REGISTER holds
    // the active grant — so two offline grants can never race the same stock. (Cross-location/cross-channel
    // consumption is instead reconciled at ingestion via stock re-lock; proven in the in-process suite.)
    const otherKeys = generateKeyPairSync("ed25519");
    const other = await tenant.enrollPosDevice({
      idempotencyKey: `http-enroll2-${randomUUID()}`,
      registerId: REGISTER2,
      installationId: "http-second",
      displayName: "http-second",
      publicKey: {
        algorithm: "Ed25519",
        encoding: "spki_der_base64",
        value: otherKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      },
      clientVersion: "0.5.0",
    });
    const status = await httpStatusOf(
      tenant.createOfflineBootstrap({
        idempotencyKey: `http-grant2-${randomUUID()}`,
        deviceId: other.deviceId,
        registerId: REGISTER2,
      }),
    );
    expect(status).toBe(409);
  });
});

// ---- Deliverable B — offline attendance capture, FULL HTTP-server-path acceptance ---------------------
// Every request leaves over HTTP to the real server/route/service/record_offline_attendance RPC on the
// isolated disposable DB. The slice is deliberately append-only + PROVISIONAL: the server acknowledges a
// durable, auditable received event (sync_status=received, adjudication=pending_policy); it NEVER writes
// payroll (public.attendance_entries) and never claims shift/payroll finality. These tests assert that
// honesty directly against the database, not just the HTTP response.

// Count of the attendance INGESTION rows (the provisional append-only store) for this tenant.
async function attendanceIngestionCount(): Promise<number> {
  const { count, error } = await admin
    .from("offline_attendance_ingestions")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}
// Count of canonical payroll attendance rows — must NEVER change due to an offline capture.
async function payrollAttendanceCount(): Promise<number> {
  const { count, error } = await admin
    .from("attendance_entries")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}

function attendanceCommand(
  overrides: Partial<OfflineAttendanceCommand> = {},
): OfflineAttendanceCommand {
  const id = randomUUID();
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    localEventId: `http-att-${id}`,
    syncCommandId: id,
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    registerId: grant.registerId,
    operatorMembershipId: grant.operatorMembershipId,
    eventType: "clock_in",
    eventAt: at,
    acceptedAt: at,
    ...overrides,
  };
}
function signAttendance(command: OfflineAttendanceCommand, privateKey = deviceKeys.privateKey) {
  return {
    command,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(
        null,
        Buffer.from(canonicalizeOfflineAttendanceCommand(command)),
        privateKey,
      ).toString("base64"),
    },
  };
}
function ingestAttendance(payload: ReturnType<typeof signAttendance>) {
  return tenant.ingestOfflineAttendance({
    idempotencyKey: payload.command.syncCommandId,
    ...payload,
  });
}

describe.sequential("Phase 9 offline attendance over the real HTTP server", () => {
  it("case A1 — clock-in is accepted as a provisional received event; payroll is untouched (DB-verified)", async () => {
    const payrollBefore = await payrollAttendanceCount();
    const ingestionsBefore = await attendanceIngestionCount();
    const payload = signAttendance(attendanceCommand({ eventType: "clock_in" }));

    const result = await ingestAttendance(payload);
    expect(result.syncStatus).toBe("received"); // NOT "synced"/final payroll
    expect(result.localEventId).toBe(payload.command.localEventId);
    expect(result.event.membershipId).toBe(grant.operatorMembershipId);
    expect(result.event.eventType).toBe("clock_in");
    expect(result.event.adjudication).toBe("pending_policy");

    // Canonical DB truth: one provisional append-only row, received + pending_policy.
    expect(await attendanceIngestionCount()).toBe(ingestionsBefore + 1);
    const { data, error } = await admin
      .from("offline_attendance_ingestions")
      .select(
        "sync_status,adjudication_status,event_type,operator_membership_id,device_id,register_id,command_fingerprint",
      )
      .eq("tenant_id", TENANT)
      .eq("sync_command_id", payload.command.syncCommandId)
      .single();
    if (error) throw error;
    expect(data).toMatchObject({
      sync_status: "received",
      adjudication_status: "pending_policy",
      event_type: "clock_in",
      operator_membership_id: grant.operatorMembershipId,
      device_id: grant.deviceId,
      register_id: grant.registerId,
    });
    expect(String(data.command_fingerprint)).toMatch(/^[a-f0-9]{64}$/);

    // The payroll attendance table is NEVER touched by an offline capture.
    expect(await payrollAttendanceCount()).toBe(payrollBefore);
  });

  it("case A2 — clock-out is accepted and attributed to the same operator", async () => {
    const result = await ingestAttendance(
      signAttendance(attendanceCommand({ eventType: "clock_out" })),
    );
    expect(result.syncStatus).toBe("received");
    expect(result.event.eventType).toBe("clock_out");
    expect(result.event.membershipId).toBe(grant.operatorMembershipId);
  });

  it("case A3 — exact replay is idempotent; changed intent under the same key conflicts (409)", async () => {
    const payload = signAttendance(attendanceCommand({ eventType: "clock_in" }));
    const first = await ingestAttendance(payload);
    const before = await attendanceIngestionCount();

    // Exact replay (same id/signature/idempotency key) returns the original, writes no second row.
    const replay = await ingestAttendance(payload);
    expect(replay.ingestionId).toBe(first.ingestionId);
    expect(await attendanceIngestionCount()).toBe(before);

    // Changed intent reusing the same syncCommandId → fingerprint mismatch → 409.
    const conflict = signAttendance({ ...payload.command, eventType: "clock_out" });
    expect(await httpStatusOf(ingestAttendance(conflict))).toBe(409);
    expect(await attendanceIngestionCount()).toBe(before); // still no new row
  });

  it("case A4 — a grant-binding mismatch (wrong register) is rejected fail-closed with no write", async () => {
    const before = await attendanceIngestionCount();
    const payload = signAttendance(attendanceCommand({ registerId: REGISTER2 }));
    expect(await httpStatusOf(ingestAttendance(payload))).toBeGreaterThanOrEqual(400);
    expect(await attendanceIngestionCount()).toBe(before);
  });

  it("case A5 — an unsupported schema version is rejected fail-closed with no write", async () => {
    const before = await attendanceIngestionCount();
    const good = signAttendance(attendanceCommand());
    const body = JSON.parse(JSON.stringify(good));
    body.command.schemaVersion = 2; // bypass client types, submit straight over HTTP
    const response = await globalThis.fetch(`${baseUrl}/api/v1/pos/offline-attendance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Id": TENANT,
        "Idempotency-Key": good.command.syncCommandId,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await attendanceIngestionCount()).toBe(before);
  });

  it("case A6 — a future eventAt outside the grant/skew window is rejected (clock-skew defence)", async () => {
    const before = await attendanceIngestionCount();
    // One hour in the future — well beyond the ±5-minute skew allowance.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const payload = signAttendance(attendanceCommand({ eventAt: future }));
    expect(await httpStatusOf(ingestAttendance(payload))).toBeGreaterThanOrEqual(400);
    expect(await attendanceIngestionCount()).toBe(before);
  });

  it("case A7 — a tampered command (signature no longer matches) is rejected 401 with no write", async () => {
    const before = await attendanceIngestionCount();
    const good = signAttendance(attendanceCommand());
    // Keep the valid signature but mutate the signed bytes → signature verification must fail.
    const body = JSON.parse(JSON.stringify(good));
    body.command.eventType = body.command.eventType === "clock_in" ? "clock_out" : "clock_in";
    const response = await globalThis.fetch(`${baseUrl}/api/v1/pos/offline-attendance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Id": TENANT,
        "Idempotency-Key": body.command.syncCommandId,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(401);
    expect(await attendanceIngestionCount()).toBe(before);
  });

  it("case A8 — the provisional attendance store is invisible to an anon client (tenant RLS)", async () => {
    const anon = createClient(
      supabaseUrl!,
      process.env.POS_TEST_SUPABASE_ANON_KEY ?? serviceRoleKey!,
      {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      },
    );
    const { data, error } = await anon
      .from("offline_attendance_ingestions")
      .select("id")
      .eq("tenant_id", TENANT);
    // Either RLS returns zero rows or the table is not selectable at all — never tenant data leakage.
    if (!error) expect(data ?? []).toEqual([]);
  });
});

// Local helper that drives ingest through an arbitrary (possibly faulty) tenant client.
function ingestSaleWith(
  client: ReturnType<ReturnType<typeof makeClient>["withTenant"]>,
  payload: ReturnType<typeof signSale>,
) {
  return client.ingestOfflineSale({ idempotencyKey: payload.command.syncCommandId, ...payload });
}
