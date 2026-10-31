import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { AuthorizationError } from "../../src/authorization/errors";
import { CompositeExternalIdentityVerifier } from "../../src/authentication/composite-external-identity-verifier";
import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import { PosTokenIssuer, PosTokenVerifier } from "../../src/authentication/pos-token";

const KEY = new Uint8Array(randomBytes(32));

function bearer(token: string): Request {
  return new Request("https://api.test/pos/context", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("POS access token issue + verify", () => {
  it("round-trips a minted token to { provider: pos_pin, subject }", async () => {
    const issuer = new PosTokenIssuer(KEY);
    const { token, subject, expiresAt } = await issuer.issue("cred-123", 3600);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const verifier = new PosTokenVerifier(KEY);
    await expect(verifier.verifyRequest(bearer(token))).resolves.toEqual({
      provider: "pos_pin",
      subject,
    });
  });

  it("rejects a POS token signed with a different key (UNAUTHENTICATED, not fall-through)", async () => {
    const token = (await new PosTokenIssuer(new Uint8Array(randomBytes(32))).issue("x", 3600))
      .token;
    await expect(new PosTokenVerifier(KEY).verifyRequest(bearer(token))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("rejects an expired POS token", async () => {
    // Mint a token that already expired by signing the claims directly.
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("pos")
      .setSubject("cred-123")
      .setIssuedAt(past - 3600)
      .setExpirationTime(past)
      .sign(KEY);
    await expect(new PosTokenVerifier(KEY).verifyRequest(bearer(token))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("signals NotAPosToken for a non-POS bearer so the composite can try Clerk", async () => {
    const verifier = new PosTokenVerifier(KEY);
    await expect(verifier.verifyRequest(bearer("not-a-jwt"))).rejects.toMatchObject({
      name: "NotAPosToken",
    });
  });
});

describe("composite identity verifier dispatch", () => {
  const clerk: ExternalIdentityVerifier = {
    verifyRequest: async () => ({ provider: "clerk", subject: "clerk-user" }),
  };

  it("routes a valid POS token to the POS provider", async () => {
    const { token } = await new PosTokenIssuer(KEY).issue("cred-9", 3600);
    const composite = new CompositeExternalIdentityVerifier(clerk, new PosTokenVerifier(KEY));
    await expect(composite.verifyRequest(bearer(token))).resolves.toEqual({
      provider: "pos_pin",
      subject: "cred-9",
    });
  });

  it("falls through to Clerk for a non-POS request", async () => {
    const composite = new CompositeExternalIdentityVerifier(clerk, new PosTokenVerifier(KEY));
    await expect(composite.verifyRequest(bearer("opaque-clerk-token"))).resolves.toEqual({
      provider: "clerk",
      subject: "clerk-user",
    });
  });

  it("does NOT fall through to Clerk when a POS-shaped token is invalid", async () => {
    const foreign = (await new PosTokenIssuer(new Uint8Array(randomBytes(32))).issue("x", 3600))
      .token;
    const composite = new CompositeExternalIdentityVerifier(clerk, new PosTokenVerifier(KEY));
    await expect(composite.verifyRequest(bearer(foreign))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("routes everything to Clerk when the POS provider is dormant", async () => {
    const composite = new CompositeExternalIdentityVerifier(clerk, null);
    const { token } = await new PosTokenIssuer(KEY).issue("cred-9", 3600);
    await expect(composite.verifyRequest(bearer(token))).resolves.toEqual({
      provider: "clerk",
      subject: "clerk-user",
    });
  });
});
