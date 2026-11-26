import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AuthorizationService } from "../../src/authorization";
import {
  CreatePosLoginRequestSchema,
  EnrollOfflinePinRequestSchema,
  PosLoginRequestSchema,
  SetPosLoginPinRequestSchema,
  SetPosOverridePasswordRequestSchema,
} from "../../src/contracts";
import { PosPinSchema } from "../../src/contracts/pos";
import {
  POS_CREDENTIAL_MAX_BODY_BYTES,
  parseJsonBody,
  PayloadTooLargeError,
  runPublicBodyRoute,
} from "../../src/http/management-route";
import { DEFAULT_SCRYPT_PARAMS, deriveOnlinePinVerifier } from "../../src/pos/offline-pin-crypto";
import { posAuthDatabaseError } from "../../src/pos/pos-auth-errors";
import type { PosAuthRepository } from "../../src/pos/pos-auth-repository";
import { PosAuthService } from "../../src/pos/pos-auth-service";
import { staffDatabaseError } from "../../src/staff/errors";

// ADR-043 §6: ASCII digits only, minimum 4, NO product maximum, never truncated. The only ceiling is the
// transport (16 KiB body → 413), which is not a PIN rule.
const LONG_PIN = "1234567890".repeat(4) + "12"; // 42 digits — far beyond the retired 8/12 caps
const UUID = "33333333-3333-4333-8333-333333333333";

describe("PosPinSchema", () => {
  it.each(["1234", "0000", "12345678", "123456789012", "1234567890123", LONG_PIN])(
    "accepts %s",
    (pin) => {
      expect(PosPinSchema.parse(pin)).toBe(pin);
    },
  );

  it.each([
    ["", "empty"],
    ["123", "three digits"],
    ["12a4", "letter"],
    [" 1234", "leading space"],
    ["1234 ", "trailing space"],
    ["12.34", "punctuation"],
    ["١٢٣٤", "Arabic-Indic digits (non-ASCII)"],
    ["１２３４", "full-width digits (non-ASCII)"],
    ["-1234", "sign"],
  ])("rejects %j (%s)", (pin) => {
    expect(PosPinSchema.safeParse(pin).success).toBe(false);
  });

  it("never truncates: the parsed value is the exact submitted string", () => {
    const pin = "9".repeat(5000);
    expect(PosPinSchema.parse(pin)).toHaveLength(5000);
  });

  it("applies the same rule on every PIN-carrying contract", () => {
    const base = {
      username: "mariam",
      displayName: "Mariam",
      roleId: UUID,
      accessScopeId: UUID,
      posRole: "admin" as const,
    };
    for (const pin of ["1234", LONG_PIN]) {
      expect(PosLoginRequestSchema.safeParse({ username: "mariam", pin }).success).toBe(true);
      expect(CreatePosLoginRequestSchema.safeParse({ ...base, pin }).success).toBe(true);
      expect(SetPosLoginPinRequestSchema.safeParse({ pin }).success).toBe(true);
      expect(
        SetPosOverridePasswordRequestSchema.safeParse({
          username: "mariam",
          pin,
          password: "long-enough-password",
        }).success,
      ).toBe(true);
      expect(
        EnrollOfflinePinRequestSchema.safeParse({
          deviceId: UUID,
          registerId: UUID,
          stepUp: { username: "mariam", pin },
        }).success,
      ).toBe(true);
    }
    for (const pin of ["123", "12x4", "١٢٣٤"]) {
      expect(PosLoginRequestSchema.safeParse({ username: "mariam", pin }).success).toBe(false);
      expect(CreatePosLoginRequestSchema.safeParse({ ...base, pin }).success).toBe(false);
      expect(SetPosLoginPinRequestSchema.safeParse({ pin }).success).toBe(false);
      expect(
        EnrollOfflinePinRequestSchema.safeParse({
          deviceId: UUID,
          registerId: UUID,
          stepUp: { username: "mariam", pin },
        }).success,
      ).toBe(false);
    }
  });
});

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/v1/pos/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("transport ceiling (infrastructure, not a PIN rule)", () => {
  const schema = z.object({ pin: z.string() }).strict();

  it("is 16 KiB", () => {
    expect(POS_CREDENTIAL_MAX_BODY_BYTES).toBe(16 * 1024);
  });

  it("parses a body under the ceiling", async () => {
    const pin = "7".repeat(10_000);
    await expect(
      parseJsonBody(jsonRequest(JSON.stringify({ pin })), schema, POS_CREDENTIAL_MAX_BODY_BYTES),
    ).resolves.toEqual({ pin });
  });

  it("refuses a streamed body over the ceiling without a Content-Length", async () => {
    const big = JSON.stringify({ pin: "7".repeat(POS_CREDENTIAL_MAX_BODY_BYTES) });
    await expect(
      parseJsonBody(jsonRequest(big), schema, POS_CREDENTIAL_MAX_BODY_BYTES),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("refuses up front on an oversized declared Content-Length", async () => {
    const request = jsonRequest("{}", { "Content-Length": String(10 * 1024 * 1024) });
    await expect(
      parseJsonBody(request, schema, POS_CREDENTIAL_MAX_BODY_BYTES),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});

describe("POST /pos/auth/login through the public runner", () => {
  const signing = { signingKey: randomBytes(32), accessTtlSeconds: 3600 };
  const account = {
    subject: "cred-long",
    tenantId: "11111111-1111-4111-8111-111111111111",
    membershipId: "22222222-2222-4222-8222-222222222222",
    displayName: "Long Pin",
    username: "longpin",
    posRole: "admin" as const,
    posPermissions: [],
    verifier: deriveOnlinePinVerifier(LONG_PIN, DEFAULT_SCRYPT_PARAMS),
  };

  function makeService() {
    const repository = {
      begin: vi.fn(async () => ({ lockedUntil: null, account })),
      record: vi.fn(async () => undefined),
    } as unknown as PosAuthRepository & { begin: ReturnType<typeof vi.fn> };
    return {
      repository,
      service: new PosAuthService({} as AuthorizationService, repository, signing),
    };
  }

  async function call(service: PosAuthService, body: string, headers?: Record<string, string>) {
    const { PosLoginResponseSchema } = await import("../../src/contracts");
    return runPublicBodyRoute({
      request: jsonRequest(body, headers),
      requestSchema: PosLoginRequestSchema,
      responseSchema: PosLoginResponseSchema,
      maxBodyBytes: POS_CREDENTIAL_MAX_BODY_BYTES,
      handler: ({ body: parsed }) => service.login(parsed),
    });
  }

  it("signs in with a PIN longer than the retired 8/12-digit caps", async () => {
    const { service } = makeService();
    const response = await call(service, JSON.stringify({ username: "longpin", pin: LONG_PIN }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { operator: { username: string } };
    expect(body.operator.username).toBe("longpin");
    expect(JSON.stringify(body)).not.toContain(LONG_PIN);
  });

  it("rejects the same PIN truncated to 12 digits (no silent truncation anywhere)", async () => {
    const { service } = makeService();
    const response = await call(
      service,
      JSON.stringify({ username: "longpin", pin: LONG_PIN.slice(0, 12) }),
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_CREDENTIALS",
    );
  });

  it("returns 400 for a malformed PIN without echoing it and without touching the repository", async () => {
    const { service, repository } = makeService();
    const response = await call(service, JSON.stringify({ username: "longpin", pin: "12a" }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("12a");
    expect(repository.begin).not.toHaveBeenCalled();
  });

  it("returns 413 PAYLOAD_TOO_LARGE for an oversized body and never verifies", async () => {
    const { service, repository } = makeService();
    const response = await call(
      service,
      JSON.stringify({ username: "longpin", pin: "1".repeat(POS_CREDENTIAL_MAX_BODY_BYTES + 1) }),
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
    expect(repository.begin).not.toHaveBeenCalled();
  });
});

describe("last-active-POS-admin error mapping (SQLSTATE ST414)", () => {
  it("maps on the pos_pin management path", () => {
    expect(posAuthDatabaseError({ code: "ST414" })).toMatchObject({
      code: "LAST_POS_ADMIN",
      httpStatus: 409,
    });
  });
  it("maps on the staff status path (deactivation from Admin Mobile or the POS)", () => {
    expect(staffDatabaseError({ code: "ST414" })).toMatchObject({
      code: "LAST_POS_ADMIN",
      httpStatus: 409,
    });
  });
});
