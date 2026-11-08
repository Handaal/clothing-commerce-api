import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import { AuthorizationError } from "../authorization/errors";
import type { VerifiedExternalIdentity } from "../authorization/model";
import type { ExternalIdentityVerifier } from "./external-identity";

/**
 * POS-native (`pos_pin`) access tokens. The connected POS login mints one of these after verifying a
 * username + PIN; every subsequent request carries it as a bearer token. It is a signed JWT with
 * `iss = "pos"` and `sub` = the server-minted `pos_pin` provider subject — nothing else is trusted from
 * the token. Authorization (binding → identity → membership → RBAC, in the requested tenant) is still
 * re-resolved per request by `AuthorizationContextResolver`, so suspending/deactivating the account is an
 * immediate kill switch regardless of the token's remaining lifetime.
 *
 * Signing is HS256 over a single server-held secret (`POS_AUTH_SIGNING_KEY`): the same service both signs
 * (login) and verifies (every request), so a symmetric key is the simplest safe choice. No device binding,
 * no refresh token, and no `jti` denylist in V1 — the per-request membership re-resolution is the
 * revocation path, which keeps the design simple.
 */

export const POS_TOKEN_ISSUER = "pos";
const POS_TOKEN_ALGORITHM = "HS256";

export interface PosTokenClaims {
  readonly subject: string;
  readonly expiresAt: Date;
}

export class PosTokenIssuer {
  constructor(private readonly signingKey: Uint8Array) {}

  /** Mint a signed POS access token for `subject`, expiring `ttlSeconds` from now. */
  async issue(subject: string, ttlSeconds: number): Promise<PosTokenClaims & { token: string }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = issuedAt + ttlSeconds;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: POS_TOKEN_ALGORITHM })
      .setIssuer(POS_TOKEN_ISSUER)
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.signingKey);
    return { token, subject, expiresAt: new Date(expiresAtSeconds * 1000) };
  }
}

/** Extract a bearer token from the Authorization header, or null when absent/malformed. */
function readBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** True when the bearer token is a JWT whose unverified `iss` claim is `"pos"`. Signature not yet checked. */
function looksLikePosToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JWTPayload;
    return payload.iss === POS_TOKEN_ISSUER;
  } catch {
    return false;
  }
}

/**
 * Verifies POS-native access tokens. In the composite verifier it runs FIRST: a bearer token that is a
 * JWT with `iss === "pos"` is a POS token, so a bad one is a hard `UNAUTHENTICATED` (never falls through to
 * Clerk). Anything that is not a POS-shaped token throws `NotAPosToken` so the composite can try Clerk.
 */
export class NotAPosToken extends Error {
  constructor() {
    super("The request does not carry a POS access token.");
    this.name = "NotAPosToken";
  }
}

export class PosTokenVerifier implements ExternalIdentityVerifier {
  constructor(private readonly signingKey: Uint8Array) {}

  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    const token = readBearerToken(request);
    if (token === null || !looksLikePosToken(token)) {
      throw new NotAPosToken();
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.signingKey, {
        issuer: POS_TOKEN_ISSUER,
        algorithms: [POS_TOKEN_ALGORITHM],
      }));
    } catch {
      throw new AuthorizationError("UNAUTHENTICATED");
    }
    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new AuthorizationError("UNAUTHENTICATED");
    }
    return { provider: "pos_pin", subject: payload.sub };
  }
}
