import { generateKeyPairSync, scryptSync, sign } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationService } from "../../src/authorization/authorization-service";
import { AuthorizationError } from "../../src/authorization/errors";
import type { VerifiedExternalIdentity } from "../../src/authorization/model";
import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import {
  EnrollPosDeviceRequestSchema,
  IngestOfflineSaleRequestSchema,
  IngestOfflineSaleResponseSchema,
  OfflineBootstrapRequestSchema,
  OfflineBootstrapResponseSchema,
  PosDeviceResponseSchema,
  RevokePosDeviceRequestSchema,
  IngestOfflineCustomerPaymentRequestSchema,
  IngestOfflineCustomerPaymentResponseSchema,
  canonicalizeOfflineSaleCommand,
  canonicalizeOfflineCustomerPaymentCommand,
  type OfflineBootstrapResponse,
  type OfflineCustomerPaymentCommand,
  type OfflineSaleCommand,
} from "../../src/contracts";
import {
  RequestValidationError,
  runTenantDeviceWriteRoute,
  runTenantManagementWriteRoute,
} from "../../src/http/management-route";
import { createSupabaseOrdersRepository } from "../../src/orders";
import { OfflinePosService } from "../../src/pos/offline-service";
import { encryptOfflinePin } from "../../src/pos/offline-pin-crypto";
import { createSupabaseOfflinePosRepository } from "../../src/pos/supabase-offline-pos-repository";
import { createSupabasePosSaleRepository } from "../../src/pos/supabase-pos-sale-repository";

const url = process.env.POS_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.POS_TEST_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.POS_TEST_SUPABASE_ANON_KEY;
if (!url || !serviceRoleKey || !anonKey)
  throw new Error("Phase 2I local Supabase environment is required.");
const config = { url, serviceRoleKey };
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const anon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const TENANT = "2a000001-0000-4000-8000-000000000001";
const FOREIGN = "2a000001-0000-4000-8000-000000000002";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const REGISTER2 = "2a000005-0000-4000-8000-000000000002";
const REGISTER3 = "2a000005-0000-4000-8000-000000000003";
const VARIANT = "2a000007-0000-4000-8000-000000000001";
// Offline-PIN roster fixtures: pos-full sells tenant-wide (INCLUDED); pos-no-payment lacks
// payments.capture and pos-wrong-location holds inventory.issue only on location ...002 (both EXCLUDED).
const POS_FULL_MEMBERSHIP = "2a000012-0000-4000-8000-000000000001";
const POS_NO_PAYMENT_MEMBERSHIP = "2a000012-0000-4000-8000-000000000002";
const POS_WRONG_LOCATION_MEMBERSHIP = "2a000012-0000-4000-8000-000000000004";
const OFFLINE_PIN_KEK = process.env.POS_TEST_OFFLINE_PIN_KEK;
if (!OFFLINE_PIN_KEK)
  throw new Error("POS_TEST_OFFLINE_PIN_KEK is required for the Phase 2I roster test.");
const kek = Buffer.from(OFFLINE_PIN_KEK, "base64");

class FakeVerifier implements ExternalIdentityVerifier {
  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    const match = request.headers.get("Authorization")?.match(/^Bearer subject:(.+)$/);
    if (!match) throw new AuthorizationError("UNAUTHENTICATED");
    return { provider: "clerk", subject: match[1]! };
  }
}
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const secondKeyPair = generateKeyPairSync("ed25519");
const secondPublicKey = secondKeyPair.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
let resolver: AuthorizationContextResolver;
let service: OfflinePosService;

beforeAll(async () => {
  const { createSupabaseAuthorizationRepository } =
    await import("../../src/authorization/supabase-authorization-repository");
  const repository = createSupabaseAuthorizationRepository(config);
  resolver = new AuthorizationContextResolver(new FakeVerifier(), repository);
  service = new OfflinePosService(
    new AuthorizationService(repository),
    createSupabasePosSaleRepository(config),
    createSupabaseOfflinePosRepository(config),
    { kek, keyVersion: 1 },
  );
  void createSupabaseOrdersRepository;
});

function request(subject: string | null, tenant: string, key: string, body: unknown) {
  const headers = new Headers({
    "X-Tenant-Id": tenant,
    "Idempotency-Key": key,
    "Content-Type": "application/json",
  });
  if (subject) headers.set("Authorization", `Bearer subject:${subject}`);
  return new Request("http://test/api/v1/pos/offline", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}
async function enroll(
  registerId: string,
  installationId: string,
  keyValue: string,
  subject = "pos-full",
  tenant = TENANT,
) {
  const input = {
    registerId,
    installationId,
    displayName: installationId,
    publicKey: {
      algorithm: "Ed25519" as const,
      encoding: "spki_der_base64" as const,
      value: keyValue,
    },
    clientVersion: "0.5.0",
  };
  return runTenantManagementWriteRoute({
    request: request(subject, tenant, `enroll-${installationId}`, input),
    contextResolver: resolver,
    requestSchema: EnrollPosDeviceRequestSchema,
    responseSchema: PosDeviceResponseSchema,
    handler: ({ context, body: parsed, idempotencyKey }) =>
      service.enrollDevice(context, parsed, idempotencyKey),
  });
}
async function bootstrap(deviceId: string, registerId = REGISTER, nonce = "1") {
  const input = { deviceId, registerId };
  return runTenantManagementWriteRoute({
    request: request("pos-full", TENANT, `grant-${deviceId}-${registerId}-${nonce}`, input),
    contextResolver: resolver,
    requestSchema: OfflineBootstrapRequestSchema,
    responseSchema: OfflineBootstrapResponseSchema,
    handler: ({ context, body: parsed, idempotencyKey }) =>
      service.createBootstrap(context, parsed.deviceId, parsed.registerId, idempotencyKey),
  });
}
function command(
  grant: OfflineBootstrapResponse,
  id: string,
  quantity: number,
  ordinal: number,
  acceptedAt = new Date().toISOString(),
): OfflineSaleCommand {
  const variant = grant.catalog
    .flatMap((product) => product.variants)
    .find((item) => item.variantId === VARIANT)!;
  const total = quantity * variant.authorizedUnitPriceMinor;
  return {
    schemaVersion: 1,
    localSaleId: `local-${id}`,
    syncCommandId: id,
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    registerId: grant.registerId,
    acceptedAt,
    currency: grant.currency,
    lines: [
      {
        variantId: VARIANT,
        quantity,
        grantedUnitPriceMinor: variant.authorizedUnitPriceMinor,
        priceId: variant.priceId,
      },
    ],
    totalMinor: total,
    cashReceivedMinor: total + 100,
    changeMinor: 100,
    offlineSaleOrdinal: ordinal,
    cumulativeExposureMinor: total,
  };
}
function signed(
  commandValue: OfflineSaleCommand,
  credentialId: string,
  privateKey = keyPair.privateKey,
) {
  const canonical = canonicalizeOfflineSaleCommand(commandValue);
  return {
    command: commandValue,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  };
}
// Seal a PIN with the run KEK and provision it through the real staff_private.set_offline_pin RPC, acting
// as the tenant-wide pos-full admin (whose permissions are a superset of every target here).
async function provisionPin(membershipId: string, pin: string) {
  const sealed = encryptOfflinePin(pin, kek, 1);
  const { error } = await admin.schema("staff_private").rpc("set_offline_pin", {
    p_tenant: TENANT,
    p_actor: POS_FULL_MEMBERSHIP,
    p_key: `pin-${membershipId}`,
    p_membership: membershipId,
    p_key_version: 1,
    p_cipher_algorithm: "aes-256-gcm",
    p_ciphertext: sealed.ciphertextBase64,
    p_iv: sealed.ivBase64,
    p_auth_tag: sealed.authTagBase64,
    p_scrypt_n: 16384,
    p_scrypt_r: 8,
    p_scrypt_p: 1,
    p_key_length: 32,
    p_salt_length: 16,
  });
  if (error) throw error;
}

function posVerifies(
  verifier: {
    saltBase64: string;
    hashBase64: string;
    n: number;
    r: number;
    p: number;
    keyLength: number;
  },
  pin: string,
  deviceId: string,
): boolean {
  const material = Buffer.concat([
    Buffer.from(verifier.saltBase64, "base64"),
    Buffer.from(deviceId, "utf8"),
  ]);
  return (
    scryptSync(pin, material, verifier.keyLength, {
      N: verifier.n,
      r: verifier.r,
      p: verifier.p,
      maxmem: 256 * 1024 * 1024,
    }).toString("base64") === verifier.hashBase64
  );
}

async function ingest(payload: ReturnType<typeof signed>) {
  return runTenantDeviceWriteRoute({
    request: request(null, TENANT, payload.command.syncCommandId, payload),
    requestSchema: IngestOfflineSaleRequestSchema,
    responseSchema: IngestOfflineSaleResponseSchema,
    handler: ({ tenantId, body: parsed, idempotencyKey }) => {
      if (idempotencyKey !== parsed.command.syncCommandId) throw new RequestValidationError([]);
      return service.ingest(tenantId, parsed);
    },
  });
}

function paymentCommand(
  grant: OfflineBootstrapResponse,
  id: string,
  customerId: string,
  amountMinor: number,
  acceptedAt = new Date().toISOString(),
): OfflineCustomerPaymentCommand {
  return {
    schemaVersion: 1,
    localPaymentId: `pay-${id}`,
    syncCommandId: id,
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    registerId: grant.registerId,
    acceptedAt,
    currency: grant.currency,
    customerId,
    amountMinor,
  };
}
function signedPayment(
  commandValue: OfflineCustomerPaymentCommand,
  credentialId: string,
  privateKey = keyPair.privateKey,
) {
  const canonical = canonicalizeOfflineCustomerPaymentCommand(commandValue);
  return {
    command: commandValue,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  };
}
async function ingestPayment(payload: ReturnType<typeof signedPayment>) {
  return runTenantDeviceWriteRoute({
    request: request(null, TENANT, payload.command.syncCommandId, payload),
    requestSchema: IngestOfflineCustomerPaymentRequestSchema,
    responseSchema: IngestOfflineCustomerPaymentResponseSchema,
    handler: ({ tenantId, body: parsed, idempotencyKey }) => {
      if (idempotencyKey !== parsed.command.syncCommandId) throw new RequestValidationError([]);
      return service.ingestPayment(tenantId, parsed);
    },
  });
}

describe.sequential("Phase 2I offline POS real HTTP/domain boundary", () => {
  let deviceId: string;
  let credentialId: string;
  let grant: OfflineBootstrapResponse;
  let successful: Record<string, unknown>;
  it("canonical serialization is deterministic and enrollment is authorized", async () => {
    const a = { z: 1, a: [{ b: "x", a: true }] };
    const b = { a: [{ a: true, b: "x" }], z: 1 };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    const response = await enroll(REGISTER, "offline-main", publicKey);
    expect(response.status).toBe(200);
    const result = await body(response);
    deviceId = String(result.deviceId);
    credentialId = String(result.credentialId);
    expect((await enroll(REGISTER, "offline-main", publicKey)).status).toBe(200);
    expect((await enroll(REGISTER, "offline-main", secondPublicKey)).status).toBe(409);
    expect(
      (await enroll(REGISTER, "offline-wrong-scope", secondPublicKey, "pos-wrong-branch")).status,
    ).toBe(403);
    expect(
      (await enroll(REGISTER, "offline-foreign", secondPublicKey, "pos-full", FOREIGN)).status,
    ).toBe(403);
  });
  it("issues exact bounded snapshot and denies overlapping location or missing policy", async () => {
    const response = await bootstrap(deviceId);
    expect(response.status).toBe(200);
    grant = OfflineBootstrapResponseSchema.parse(await response.json());
    expect(grant).toMatchObject({
      tenantId: TENANT,
      deviceId,
      registerId: REGISTER,
      inventoryLocationId: "2a000004-0000-4000-8000-000000000001",
      currency: "USD",
      policy: {
        maxSaleAmountMinor: 6000,
        maxQuantityPerLine: 3,
        maxPendingOfflineSales: 3,
        maxOfflineCreditExposureMinor: 8000,
      },
    });
    expect(grant.catalog.flatMap((product) => product.variants)).toContainEqual(
      expect.objectContaining({ variantId: VARIANT, authorizedUnitPriceMinor: 2500, active: true }),
    );
    // Phase D: the offline bootstrap delivers the tenant's customers with their current balance so the
    // till can attach installments and show running tabs offline.
    expect(grant.customers).toContainEqual(
      expect.objectContaining({
        customerId: "2a000030-0000-4000-8000-000000000001",
        name: "Layla Hassan",
        phone: "+201000000000",
        outstandingMinor: 0,
      }),
    );
    const other = await enroll(REGISTER2, "offline-second", secondPublicKey);
    const otherDevice = String((await body(other)).deviceId);
    expect((await bootstrap(otherDevice, REGISTER2)).status).toBe(409);
    const thirdKeys = generateKeyPairSync("ed25519");
    const third = await enroll(
      REGISTER3,
      "offline-no-policy",
      thirdKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    );
    expect((await bootstrap(String((await body(third)).deviceId), REGISTER3)).status).toBe(403);
  });
  it("emits a device-bound offline staff roster of exactly the register's authorized sellers", async () => {
    // Give all three POS staff a PIN. Only pos-full is an authorized seller on REGISTER's branch AND
    // location; the other two fail scope coverage (no payments.capture / wrong inventory location).
    await provisionPin(POS_FULL_MEMBERSHIP, "4821");
    await provisionPin(POS_NO_PAYMENT_MEMBERSHIP, "1111");
    await provisionPin(POS_WRONG_LOCATION_MEMBERSHIP, "2222");

    // Replaying the original grant (same idempotency key) returns the stored grant, but the roster is
    // recomputed per bootstrap and is now populated and device-bound to THIS device.
    // Replaying the original grant (same idempotency key) returns the stored grant over the real HTTP
    // boundary, which also validates that the response contract accepts the new staffRoster field.
    const rosterResponse = await bootstrap(deviceId);
    const rosterText = await rosterResponse.text();
    if (rosterResponse.status !== 200)
      throw new Error(`roster bootstrap failed ${rosterResponse.status}: ${rosterText}`);
    const rostered = OfflineBootstrapResponseSchema.parse(JSON.parse(rosterText));
    expect(rostered.grantId).toBe(grant.grantId);
    expect(rostered.staffRoster).toBeDefined();
    const roster = rostered.staffRoster!;
    expect(roster.map((entry) => entry.membershipId)).toEqual([POS_FULL_MEMBERSHIP]);
    const entry = roster[0]!;
    expect(entry).toMatchObject({
      membershipId: POS_FULL_MEMBERSHIP,
      username: "pos.full",
      pinVerifier: { algorithm: "scrypt", n: 16384, r: 8, p: 1, keyLength: 32 },
    });
    expect(Buffer.from(entry.pinVerifier.saltBase64, "base64").length).toBeGreaterThanOrEqual(16);
    // The POS KDF validates the correct PIN for THIS device, and rejects a wrong PIN or another device.
    expect(posVerifies(entry.pinVerifier, "4821", deviceId)).toBe(true);
    expect(posVerifies(entry.pinVerifier, "0000", deviceId)).toBe(false);
    expect(posVerifies(entry.pinVerifier, "4821", "a-different-device")).toBe(false);
    // The excluded sellers never leak into the roster even though they now have PINs.
    expect(roster.map((e) => e.membershipId)).not.toContain(POS_NO_PAYMENT_MEMBERSHIP);
    expect(roster.map((e) => e.membershipId)).not.toContain(POS_WRONG_LOCATION_MEMBERSHIP);
  });
  it("rejects tampering, wrong device, expired acceptance, and policy limits", async () => {
    const base = command(grant, "2a000030-0000-4000-8000-000000000001", 2, 1);
    const tampered = signed(base, credentialId);
    tampered.command = { ...tampered.command, totalMinor: 4999 };
    expect((await ingest(tampered)).status).toBe(401);
    expect(
      (
        await ingest(
          signed(
            {
              ...base,
              syncCommandId: "2a000030-0000-4000-8000-000000000002",
              localSaleId: "wrong-device",
            },
            "2a000000-0000-4000-8000-000000000099",
          ),
        )
      ).status,
    ).toBe(401);
    const expired = command(
      grant,
      "2a000030-0000-4000-8000-000000000003",
      1,
      1,
      new Date(new Date(grant.acceptedUntil).valueOf() + 1000).toISOString(),
    );
    expect((await ingest(signed(expired, credentialId))).status).toBe(409);
    const overSale = command(grant, "2a000030-0000-4000-8000-000000000004", 3, 1);
    expect((await ingest(signed(overSale, credentialId))).status).toBe(422);
    const overLine = command(grant, "2a000030-0000-4000-8000-000000000005", 4, 1);
    expect((await ingest(signed(overLine, credentialId))).status).toBe(422);
    const overPending = command(grant, "2a000030-0000-4000-8000-000000000006", 1, 4);
    expect((await ingest(signed(overPending, credentialId))).status).toBe(422);
    const overExposure = command(grant, "2a000030-0000-4000-8000-000000000007", 2, 1);
    expect(
      (await ingest(signed({ ...overExposure, cumulativeExposureMinor: 10001 }, credentialId)))
        .status,
    ).toBe(422);
  });
  it("accepts the grant price after the catalog price changes and replays exactly once", async () => {
    const changed = await admin.rpc("phase_2i_test_set_price", { p_amount: 2999 });
    if (changed.error) throw changed.error;
    const sale = command(grant, "2a000030-0000-4000-8000-000000000010", 2, 1);
    const response = await ingest(signed(sale, credentialId));
    expect(response.status).toBe(200);
    successful = await body(response);
    expect(successful).toMatchObject({
      syncStatus: "synced",
      order: { totalMinor: 5000 },
      payment: { status: "captured", amountMinor: 5000 },
      fulfillment: { inventoryLocationId: grant.inventoryLocationId },
    });
    const countTables = ["orders", "payments", "fulfillments", "offline_sale_ingestions"];
    const counts = await Promise.all(
      countTables.map((table) =>
        admin.from(table).select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
      ),
    );
    const replay = await body(await ingest(signed(sale, credentialId)));
    expect(replay).toEqual(successful);
    const replayCounts = await Promise.all(
      countTables.map((table) =>
        admin.from(table).select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
      ),
    );
    expect(replayCounts.map((result) => result.count)).toEqual(
      counts.map((result) => result.count),
    );
    const conflict = signed({ ...sale, totalMinor: 4999, changeMinor: 101 }, credentialId);
    expect((await ingest(conflict)).status).toBe(409);
  });
  it("rolls back every business mutation after an unexpected mid-composition failure", async () => {
    const sale = command(grant, "2a000030-0000-4000-8000-000000000040", 1, 2);
    const tables = [
      "orders",
      "payments",
      "fulfillments",
      "inventory_operations",
      "inventory_movements",
      "offline_sale_ingestions",
    ];
    const countsBefore = await Promise.all(
      tables.map((table) =>
        admin.from(table).select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
      ),
    );
    const balanceBefore = await admin
      .from("inventory_balances")
      .select("on_hand_quantity")
      .eq("tenant_id", TENANT)
      .eq("variant_id", VARIANT)
      .single();

    expect((await ingest(signed(sale, credentialId))).status).toBe(500);

    const countsAfter = await Promise.all(
      tables.map((table) =>
        admin.from(table).select("*", { count: "exact", head: true }).eq("tenant_id", TENANT),
      ),
    );
    const balanceAfter = await admin
      .from("inventory_balances")
      .select("on_hand_quantity")
      .eq("tenant_id", TENANT)
      .eq("variant_id", VARIANT)
      .single();
    expect(countsAfter.map((result) => result.count)).toEqual(
      countsBefore.map((result) => result.count),
    );
    expect(balanceAfter.data?.on_hand_quantity).toBe(balanceBefore.data?.on_hand_quantity);
  });
  it("persists insufficient stock as reconciliation without fulfillment or negative inventory", async () => {
    const depleted = await admin.rpc("phase_2i_test_deplete_stock");
    if (depleted.error) throw depleted.error;
    const sale = command(grant, "2a000030-0000-4000-8000-000000000020", 1, 2);
    const response = await ingest(signed({ ...sale, cumulativeExposureMinor: 7500 }, credentialId));
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result).toMatchObject({
      syncStatus: "needs_reconciliation",
      fulfillment: null,
      reconciliation: { reason: "insufficient_stock_at_ingestion", status: "open" },
      order: { totalMinor: 2500 },
      payment: { amountMinor: 2500 },
    });
    expect(
      await body(await ingest(signed({ ...sale, cumulativeExposureMinor: 7500 }, credentialId))),
    ).toEqual(result);
    const reconciliations = await admin
      .from("offline_reconciliations")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", TENANT);
    expect(reconciliations.count).toBe(1);
    const balance = await admin
      .from("inventory_balances")
      .select("on_hand_quantity")
      .eq("tenant_id", TENANT)
      .eq("variant_id", VARIANT)
      .single();
    expect(Number(balance.data?.on_hand_quantity)).toBe(0);
  });
  it("verifies and rejects an offline paydown that exceeds the customer's outstanding", async () => {
    // Phase D2: a signed paydown for the seeded customer (who has no debt) must verify end-to-end —
    // signature, grant binding, credential, customer lookup — then be rejected as an overpayment (422),
    // proving the record_offline_customer_payment path and its CA409 -> blocking mapping on a live DB.
    const customer = "2a000030-0000-4000-8000-000000000001";
    const rejected = await ingestPayment(
      signedPayment(
        paymentCommand(grant, "2a000030-0000-4000-8000-000000000051", customer, 500),
        credentialId,
      ),
    );
    expect(rejected.status).toBe(422);
    // A tampered signature is rejected before any A/R work.
    const tampered = signedPayment(
      paymentCommand(grant, "2a000030-0000-4000-8000-000000000052", customer, 500),
      credentialId,
    );
    tampered.command.amountMinor = 600;
    expect((await ingestPayment(tampered)).status).toBe(401);
  });
  it("revocation blocks grants but preserves queued commercial events for governed recovery", async () => {
    const queued = command(grant, "2a000030-0000-4000-8000-000000000030", 1, 3);
    const revokeBody = { registerId: REGISTER, reason: "integration test" };
    const revoked = await runTenantManagementWriteRoute({
      request: request("pos-full", TENANT, "revoke-main", revokeBody),
      contextResolver: resolver,
      requestSchema: RevokePosDeviceRequestSchema,
      responseSchema: PosDeviceResponseSchema,
      handler: ({ context, body: parsed, idempotencyKey }) =>
        service.revokeDevice(context, deviceId, parsed.registerId, parsed.reason, idempotencyKey),
    });
    expect(revoked.status).toBe(200);
    expect((await bootstrap(deviceId, REGISTER, "after-revoke")).status).toBe(409);
    const result = await body(
      await ingest(signed({ ...queued, cumulativeExposureMinor: 10000 }, credentialId)),
    );
    expect(result).toMatchObject({
      syncStatus: "needs_reconciliation",
      fulfillment: null,
      reconciliation: { reason: "device_revoked_at_ingestion" },
    });
  });
  it("keeps all new tenant tables invisible to anonymous clients", async () => {
    for (const table of [
      "offline_pos_policies",
      "device_credentials",
      "offline_device_management_commands",
      "offline_grants",
      "offline_sale_ingestions",
      "offline_payment_ingestions",
      "offline_reconciliations",
      "offline_reconciliation_events",
    ]) {
      const result = await anon.from(table).select("*");
      expect(result.data ?? []).toEqual([]);
    }
  });
});
