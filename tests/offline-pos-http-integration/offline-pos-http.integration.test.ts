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
  canonicalizeOfflineReturnCommand,
  canonicalizeOfflineIntentCommand,
  canonicalizeOfflineCustomerCommand,
  OfflineBootstrapResponseSchema,
  type OfflineBootstrapResponse,
  type OfflineSaleCommand,
  type OfflineCustomerPaymentCommand,
  type OfflineAttendanceCommand,
  type OfflineReturnCommand,
  type OfflineReturnGrantResponse,
  type OfflineIntentCommand,
  type OfflineCustomerCommand,
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
async function storedPaymentStatuses(
  orderId: string,
): Promise<Array<{ method: string; status: string; capturedAt: string | null }>> {
  const { data, error } = await admin
    .from("payments")
    .select("method,status,captured_at,tender_sequence")
    .eq("tenant_id", TENANT)
    .eq("order_id", orderId)
    .order("tender_sequence", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    method: String(row.method),
    status: String(row.status),
    capturedAt: row.captured_at == null ? null : String(row.captured_at),
  }));
}

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
  it("reads register stock with selling permissions", async () => {
    const availability = await tenant.getPosAvailability(REGISTER);
    expect(availability.registerId).toBe(REGISTER);
    expect(availability.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: VARIANT, onHand: expect.any(Number) }),
      ]),
    );
  });

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
    if (paid.syncStatus !== "synced") throw new Error("expected an applied paydown");
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
  // ADR-042 §13.3 (supersedes §4.7 / Finding B): the POS has no payment gateway. The card tender is a
  // cashier-entered record; once synced it is recorded in the server ledger exactly like a connected POS
  // tender (status captured = recorded), confirmation "cashier_recorded". No "awaiting provider" state.
  it("case 4 — card-only offline tender is stored with its true method as a cashier-recorded ledger tender (DB-verified)", async () => {
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
    expect(card.confirmation).toBe("cashier_recorded");
    expect(card.capturedAt).not.toBeNull();
    expect(card.amountMinor).toBe(total);
    expect(result.payment.method).toBe("card"); // primary of a card-only sale is the card
    const stored = await storedPaymentStatuses(result.order.id);
    expect(stored.map(({ method, status }) => ({ method, status }))).toEqual([
      { method: "card", status: "captured" },
    ]);
    expect(stored[0]!.capturedAt).not.toBeNull();
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
    // Both legs are cashier-recorded ledger tenders (ADR-042 §13.3); no provider state exists.
    const statuses = await storedPaymentStatuses(result.order.id);
    expect(statuses.map(({ method, status }) => ({ method, status }))).toEqual([
      { method: "cash", status: "captured" },
      { method: "card", status: "captured" },
    ]);
    expect(statuses[0]!.capturedAt).not.toBeNull();
    expect(statuses[1]!.capturedAt).not.toBeNull();
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

function appliedAttendance<T extends { syncStatus: string }>(value: T) {
  if (value.syncStatus !== "received")
    throw new Error(`expected an applied clock event, got ${value.syncStatus}`);
  return value as Extract<T, { syncStatus: "received" }>;
}

describe.sequential("Phase 9 offline attendance over the real HTTP server", () => {
  it("case A1 — clock-in is applied to canonical attendance after sync", async () => {
    const payrollBefore = await payrollAttendanceCount();
    const ingestionsBefore = await attendanceIngestionCount();
    const payload = signAttendance(attendanceCommand({ eventType: "clock_in" }));

    const result = appliedAttendance(await ingestAttendance(payload));
    expect(result.syncStatus).toBe("received"); // NOT "synced"/final payroll
    expect(result.localEventId).toBe(payload.command.localEventId);
    expect(result.event.membershipId).toBe(grant.operatorMembershipId);
    expect(result.event.eventType).toBe("clock_in");
    expect(result.event.adjudication).toBe("applied");

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
      adjudication_status: "applied",
      event_type: "clock_in",
      operator_membership_id: grant.operatorMembershipId,
      device_id: grant.deviceId,
      register_id: grant.registerId,
    });
    expect(String(data.command_fingerprint)).toMatch(/^[a-f0-9]{64}$/);

    expect(await payrollAttendanceCount()).toBe(payrollBefore + 1);
  });

  it("case A2 — clock-out is accepted and attributed to the same operator", async () => {
    const result = appliedAttendance(
      await ingestAttendance(signAttendance(attendanceCommand({ eventType: "clock_out" }))),
    );
    expect(result.syncStatus).toBe("received");
    expect(result.event.eventType).toBe("clock_out");
    expect(result.event.membershipId).toBe(grant.operatorMembershipId);
  });

  it("case A2b — a team member without a POS account is clocked in and out", async () => {
    const membershipId = "2a000012-0000-4000-8000-000000000002";
    const before = await payrollAttendanceCount();
    const clockIn = appliedAttendance(
      await ingestAttendance(signAttendance(attendanceCommand({ membershipId }))),
    );
    expect(clockIn.event).toMatchObject({ membershipId, adjudication: "applied" });
    const clockOut = appliedAttendance(
      await ingestAttendance(
        signAttendance(attendanceCommand({ membershipId, eventType: "clock_out" })),
      ),
    );
    expect(clockOut.event).toMatchObject({ membershipId, adjudication: "applied" });
    expect(await payrollAttendanceCount()).toBe(before + 1);
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

// ---- Phase 5 (Decision A) — offline RETURNS, FULL HTTP-server-path acceptance -------------------------
// Each return is executed against a canonical order created by the offline-sale path (placed + cash
// captured + fulfilled), so the order is genuinely returnable. The server freezes eligibility into a
// signed grant, then the till signs a return command; the server recomputes the NET refund, records a
// canonical Return with a PENDING (withheld) refund, and never posts stock at ingestion.

async function onHand(variantId: string, locationId: string): Promise<number> {
  const { data, error } = await admin
    .from("inventory_balances")
    .select("on_hand_quantity")
    .eq("tenant_id", TENANT)
    .eq("variant_id", variantId)
    .eq("inventory_location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.on_hand_quantity) : 0;
}
async function returnIngestionCount(): Promise<number> {
  const { count, error } = await admin
    .from("offline_return_ingestions")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}
// Create a fresh returnable order (cash sale, synced with a fulfillment) and return its orderId.
async function freshReturnableOrder(): Promise<string> {
  const sale = await ingestSale(
    signSale(
      saleCommand({
        lines: [
          {
            variantId: VARIANT,
            quantity: 1,
            grantedUnitPriceMinor: unitPrice(),
            priceId: priceId(),
          },
        ],
      }),
    ),
  );
  expect(sale.syncStatus).toBe("synced");
  return sale.order.id;
}
function issueReturnGrant(orderId: string) {
  return tenant.issueOfflineReturnGrant({
    idempotencyKey: `http-return-grant-${randomUUID()}`,
    deviceId,
    registerId: REGISTER,
    orderId,
  });
}
function returnCommand(
  rg: OfflineReturnGrantResponse,
  overrides: Partial<OfflineReturnCommand> = {},
): OfflineReturnCommand {
  const id = randomUUID();
  const line = rg.lines[0]!;
  return {
    schemaVersion: 1,
    localReturnId: `http-return-${id}`,
    syncCommandId: id,
    returnGrantId: rg.returnGrantId,
    deviceId: rg.deviceId,
    registerId: rg.registerId,
    orderId: rg.orderId,
    acceptedAt: new Date().toISOString(),
    currency: rg.currency,
    lines: [
      {
        orderLineId: line.orderLineId,
        quantity: 1,
        reason: "customer changed mind",
        disposition: "non_restock",
      },
    ],
    ...overrides,
  };
}
function signReturn(command: OfflineReturnCommand, privateKey = deviceKeys.privateKey) {
  return {
    command,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(
        null,
        Buffer.from(canonicalizeOfflineReturnCommand(command)),
        privateKey,
      ).toString("base64"),
    },
  };
}
function ingestReturn(payload: ReturnType<typeof signReturn>) {
  return tenant.ingestOfflineReturn({ idempotencyKey: payload.command.syncCommandId, ...payload });
}

// ADR-042 §13 (owner decision 2026-11-14 night): returns are ONLINE-ONLY. The Phase 5 offline-return lane
// is retired: issuing a return grant and ingesting a (stale, queued) offline return both fail closed with a
// deterministic 409 OFFLINE_RETURNS_DISABLED and leave no return, refund, inventory or payment side effect.
describe.sequential("ADR-042 §13 offline returns are online-only over the real HTTP server", () => {
  async function counts(orderId: string) {
    const [returns, payments] = await Promise.all([
      admin.from("returns").select("id", { count: "exact", head: true }).eq("order_id", orderId),
      admin.from("payments").select("id", { count: "exact", head: true }).eq("order_id", orderId),
    ]);
    return { returns: returns.count ?? 0, payments: payments.count ?? 0 };
  }

  it("case X1 — issuing an offline return grant is refused (409 OFFLINE_RETURNS_DISABLED)", async () => {
    const orderId = await freshReturnableOrder();
    const error = await issueReturnGrant(orderId).then(
      () => null,
      (e: unknown) => e as { status?: number; code?: string },
    );
    expect(error?.status).toBe(409);
    expect(error?.code).toBe("OFFLINE_RETURNS_DISABLED");
  });

  it("case X2 — a stale till's signed offline return is refused with no side effect (DB-verified)", async () => {
    const orderId = await freshReturnableOrder();
    const before = await counts(orderId);
    const ingestionsBefore = await returnIngestionCount();
    const stockBefore = await onHand(VARIANT, grant.inventoryLocationId);
    const { data: line } = await admin
      .from("order_lines")
      .select("id")
      .eq("order_id", orderId)
      .limit(1)
      .single();
    const staleGrant = {
      returnGrantId: randomUUID(),
      deviceId,
      registerId: REGISTER,
      orderId,
      currency: grant.currency,
      lines: [{ orderLineId: String(line!.id) }],
    } as unknown as OfflineReturnGrantResponse;
    const payload = signReturn(returnCommand(staleGrant));
    const error = await ingestReturn(payload).then(
      () => null,
      (e: unknown) => e as { status?: number; code?: string },
    );
    expect(error?.status).toBe(409);
    expect(error?.code).toBe("OFFLINE_RETURNS_DISABLED");
    expect(await counts(orderId)).toEqual(before);
    expect(await onHand(VARIANT, grant.inventoryLocationId)).toBe(stockBefore);
    expect(await returnIngestionCount()).toBe(ingestionsBefore);
  });
});

// All-desks offline program — offline operation intents with AUTOMATIC SERVER DISPOSITION over the real HTTP
// server. The runner opts this disposable register into a subset of operations and configures per-run handler
// policies (receive maxQuantity 50, adjust maxAbsDelta 20, count maxAbsVariance 30, self-revoke). These are
// test fixture values, not owner-approved limits. There is no human approval step: every accepted command
// carries its final disposition (applied / rejected / needs_reconciliation / blocked_policy) in the response.

async function intentCount(): Promise<number> {
  const { count, error } = await admin
    .from("offline_operation_intents")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}
async function balance(variantId: string): Promise<{ onHand: number; version: number }> {
  const { data, error } = await admin
    .from("inventory_balances")
    .select("on_hand_quantity,version")
    .eq("tenant_id", TENANT)
    .eq("variant_id", variantId)
    .eq("inventory_location_id", grant.inventoryLocationId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { onHand: Number(data.on_hand_quantity), version: Number(data.version) }
    : { onHand: 0, version: 0 };
}
async function storedIntent(syncCommandId: string) {
  const { data, error } = await admin
    .from("offline_operation_intents")
    .select(
      "sync_status,adjudication_status,disposition_code,disposition_detail,policy_version,decided_at,operation,device_id,register_id,inventory_location_id,operator_membership_id,payload,command_fingerprint",
    )
    .eq("tenant_id", TENANT)
    .eq("sync_command_id", syncCommandId)
    .single();
  if (error) throw error;
  return data;
}

type IntentOverrides = Partial<Omit<OfflineIntentCommand, "operation" | "payload">>;
function intentBase(overrides: IntentOverrides = {}) {
  const id = randomUUID();
  return {
    schemaVersion: 1 as const,
    localIntentId: `http-intent-${id}`,
    syncCommandId: id,
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    registerId: grant.registerId,
    operatorMembershipId: grant.operatorMembershipId,
    subjectId: null,
    baseVersion: null,
    dependsOnSyncCommandId: null,
    acceptedAt: new Date().toISOString(),
    ...overrides,
  };
}
function receiveIntent(
  overrides: IntentOverrides = {},
  quantity = 3,
  variantId = VARIANT,
): OfflineIntentCommand {
  return {
    ...intentBase({ subjectId: variantId, ...overrides }),
    operation: "inventory.receive",
    payload: { variantId, quantity, supplierDocumentRef: "DN-1001", note: null },
  };
}
function adjustIntent(quantityDelta: number, variantId = VARIANT): OfflineIntentCommand {
  return {
    ...intentBase({ subjectId: variantId }),
    operation: "inventory.adjust",
    payload: { variantId, quantityDelta, reason: "damaged", note: null },
  };
}
function signIntent(command: OfflineIntentCommand, privateKey = deviceKeys.privateKey) {
  return {
    command,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(
        null,
        Buffer.from(canonicalizeOfflineIntentCommand(command)),
        privateKey,
      ).toString("base64"),
    },
  };
}
function ingestIntent(payload: ReturnType<typeof signIntent>) {
  return tenant.ingestOfflineIntent({ idempotencyKey: payload.command.syncCommandId, ...payload });
}

describe.sequential("ADR-042 offline scope over real HTTP", () => {
  it("case R0 — the bootstrap offers no generic intent kind and, at a legacy location, no stock grant", () => {
    expect(grant.policy.intentOperations).toEqual([]);
    expect(grant.stockGrant ?? null).toBeNull();
  });

  it("case R1 — a received generic intent is rejected out of scope with no stock effect (DB-verified)", async () => {
    const before = await balance(VARIANT);
    const payload = signIntent(receiveIntent({}, 7));
    const result = await ingestIntent(payload);
    expect(result.intent).toMatchObject({
      operation: "inventory.receive",
      disposition: "rejected",
      code: "OIX_KIND_OUT_OF_SCOPE",
    });
    const stored = await storedIntent(payload.command.syncCommandId);
    expect(stored).toMatchObject({
      adjudication_status: "rejected",
      disposition_code: "OIX_KIND_OUT_OF_SCOPE",
    });
    expect(await balance(VARIANT)).toEqual(before);
  });

  it("case R2 — exact replay returns the original disposition; changed intent under the same id is 409", async () => {
    const payload = signIntent(adjustIntent(-2));
    const first = await ingestIntent(payload);
    const before = await intentCount();
    expect(await ingestIntent(payload)).toEqual(first);
    expect(await intentCount()).toBe(before);
    const changed = signIntent({
      ...payload.command,
      payload: { ...payload.command.payload, quantityDelta: -3 },
    } as OfflineIntentCommand);
    expect(await httpStatusOf(ingestIntent(changed))).toBe(409);
  });

  it("case R3 — a tampered generic intent is still rejected 401 with no write", async () => {
    const before = await intentCount();
    const payload = signIntent(receiveIntent());
    const tampered = {
      ...payload,
      command: { ...payload.command, payload: { ...payload.command.payload, quantity: 9 } },
    };
    expect(await httpStatusOf(ingestIntent(tampered as typeof payload))).toBe(401);
    expect(await intentCount()).toBe(before);
  });

  it("case R4 — the intent store is invisible to an anon client (tenant RLS)", async () => {
    const anon = createClient(
      supabaseUrl!,
      process.env.POS_TEST_SUPABASE_ANON_KEY ?? serviceRoleKey!,
      { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } },
    );
    const { data, error } = await anon
      .from("offline_operation_intents")
      .select("id")
      .eq("tenant_id", TENANT);
    if (!error) expect(data ?? []).toEqual([]);
  });

  function customerCommand(name: string, phone: string): OfflineCustomerCommand {
    return {
      schemaVersion: 1,
      syncCommandId: randomUUID(),
      localCustomerId: randomUUID(),
      grantId: grant.grantId,
      deviceId: grant.deviceId,
      registerId: grant.registerId,
      acceptedAt: new Date().toISOString(),
      name,
      phone,
    };
  }
  function signCustomer(command: OfflineCustomerCommand, privateKey = deviceKeys.privateKey) {
    return {
      command,
      signature: {
        algorithm: "Ed25519" as const,
        credentialId,
        value: sign(
          null,
          Buffer.from(canonicalizeOfflineCustomerCommand(command)),
          privateKey,
        ).toString("base64"),
      },
    };
  }

  it("case C1 — an offline new customer is created with the till's id; replay is idempotent", async () => {
    const payload = signCustomer(customerCommand("Omar Adel", "+201005550101"));
    const first = await tenant.ingestOfflineCustomer({
      idempotencyKey: payload.command.syncCommandId,
      ...payload,
    });
    expect(first).toMatchObject({
      localCustomerId: payload.command.localCustomerId,
      customerId: payload.command.localCustomerId,
      duplicateOfCustomerId: null,
    });
    const again = await tenant.ingestOfflineCustomer({
      idempotencyKey: payload.command.syncCommandId,
      ...payload,
    });
    expect(again).toEqual(first);
  });

  it("case C2 — a phone that already exists is flagged as a duplicate, never merged", async () => {
    const original = signCustomer(customerCommand("Mona One", "+201005550102"));
    const created = await tenant.ingestOfflineCustomer({
      idempotencyKey: original.command.syncCommandId,
      ...original,
    });
    const dup = signCustomer(customerCommand("Mona Two", "+20 100 555 0102"));
    const flagged = await tenant.ingestOfflineCustomer({
      idempotencyKey: dup.command.syncCommandId,
      ...dup,
    });
    expect(flagged.duplicateOfCustomerId).toBe(created.customerId);
    expect(flagged.customerId).not.toBe(created.customerId);
  });

  it("case C3 — a tampered or unsigned-key customer command is 401; an invalid phone is a 4xx", async () => {
    const payload = signCustomer(customerCommand("Tamper", "+201005550103"));
    const tampered = { ...payload, command: { ...payload.command, name: "Changed" } };
    expect(
      await httpStatusOf(
        tenant.ingestOfflineCustomer({
          idempotencyKey: tampered.command.syncCommandId,
          ...tampered,
        }),
      ),
    ).toBe(401);
    const bad = signCustomer(customerCommand("Bad Phone", "0100555"));
    const status = await httpStatusOf(
      tenant.ingestOfflineCustomer({ idempotencyKey: bad.command.syncCommandId, ...bad }),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});

// ADR-042 §13.5 — post-sync conflict report over the real HTTP server. Runs last: it reads conflicts the
// cases above produced (duplicate customer C2) and records a stale-debt paydown conflict of its own.
describe.sequential("ADR-042 §13.5 sync conflict report over real HTTP", () => {
  it("case K1 — a paydown above the server's outstanding is preserved as a conflict, not lost or applied", async () => {
    const { count: paymentsBefore } = await admin
      .from("customer_payments")
      .select("id", { count: "exact", head: true });
    const payCommand = {
      schemaVersion: 1 as const,
      localPaymentId: `pay-${randomUUID()}`,
      syncCommandId: randomUUID(),
      grantId: grant.grantId,
      deviceId: grant.deviceId,
      registerId: grant.registerId,
      acceptedAt: new Date().toISOString(),
      currency: grant.currency,
      customerId: CUSTOMER,
      amountMinor: 9_999_999,
    };
    const payload = signPayment(payCommand);
    const first = await tenant.ingestOfflineCustomerPayment({
      idempotencyKey: payCommand.syncCommandId,
      ...payload,
    });
    expect(first.syncStatus).toBe("conflict_recorded");
    if (first.syncStatus !== "conflict_recorded") throw new Error("expected a conflict");
    expect(first.conflict).toMatchObject({
      kind: "customer_debt",
      reasonCode: "PAYDOWN_EXCEEDS_OUTSTANDING",
    });
    const replay = await tenant.ingestOfflineCustomerPayment({
      idempotencyKey: payCommand.syncCommandId,
      ...payload,
    });
    expect(replay).toEqual(first);
    const { count: paymentsAfter } = await admin
      .from("customer_payments")
      .select("id", { count: "exact", head: true });
    expect(paymentsAfter).toBe(paymentsBefore);
  });

  it("case K2 — the register view lists conflicts newest first with counts and no customer PII", async () => {
    const report = await tenant.listPosSyncConflicts({ registerId: REGISTER });
    expect(report.summary.open).toBeGreaterThanOrEqual(1);
    expect(report.summary.informational).toBeGreaterThanOrEqual(1);
    const kinds = new Set(report.items.map((item) => item.kind));
    expect(kinds.has("customer_debt")).toBe(true);
    expect(kinds.has("customer_duplicate")).toBe(true);
    for (const item of report.items) expect(item.registerId).toBe(REGISTER);
    const sorted = [...report.items].sort((x, y) => y.detectedAt.localeCompare(x.detectedAt));
    expect(report.items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
    const wire = JSON.stringify(report);
    expect(wire).not.toMatch(/Mona|Layla|\+20100555/);
    const onlyDebt = await tenant.listPosSyncConflicts({ kind: "customer_debt", limit: 5 });
    expect(onlyDebt.items.every((item) => item.kind === "customer_debt")).toBe(true);
  });

  it("case K3 — the conflict table is invisible to an anon client (RLS)", async () => {
    const anon = createClient(
      supabaseUrl!,
      process.env.POS_TEST_SUPABASE_ANON_KEY ?? serviceRoleKey!,
      { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } },
    );
    for (const table of ["pos_sync_conflicts", "offline_conflict_ingestions"]) {
      const { data, error } = await anon.from(table).select("id").eq("tenant_id", TENANT);
      if (!error) expect(data ?? []).toEqual([]);
    }
  });
});
