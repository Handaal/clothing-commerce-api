import { createClerkClient } from "@clerk/backend";

import { AuthorizationError } from "../authorization/errors";
import type { VerifiedExternalIdentity } from "../authorization/model";
import type { ExternalIdentityVerifier } from "./external-identity";

interface ClerkAuthenticationResult {
  readonly isAuthenticated: boolean;
  toAuth(): {
    readonly userId: string | null;
    readonly sessionId: string | null;
    readonly sessionClaims?: Readonly<Record<string, unknown>> | null;
  } | null;
}

export type ClerkAuthenticateRequest = (request: Request) => Promise<ClerkAuthenticationResult>;

export class ClerkRequestVerifier implements ExternalIdentityVerifier {
  constructor(private readonly authenticateRequest: ClerkAuthenticateRequest) {}

  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    try {
      const result = await this.authenticateRequest(request);
      if (!result.isAuthenticated) {
        throw new AuthorizationError("UNAUTHENTICATED");
      }

      const auth = result.toAuth();
      if (!auth?.userId) {
        throw new AuthorizationError("UNAUTHENTICATED");
      }

      return {
        provider: "clerk",
        subject: auth.userId,
        ...(auth.sessionId ? { sessionId: auth.sessionId } : {}),
      };
    } catch {
      throw new AuthorizationError("UNAUTHENTICATED");
    }
  }
}

export interface ClerkVerifierConfiguration {
  readonly secretKey: string;
  readonly publishableKey: string;
  readonly authorizedParties: readonly string[];
  readonly jwtKey?: string;
}

export function isClerkAuthorizedPartyAllowed(
  authorizedParty: unknown,
  allowedParties: readonly string[],
): boolean {
  return (
    authorizedParty === undefined ||
    (typeof authorizedParty === "string" && allowedParties.includes(authorizedParty))
  );
}

export function createClerkRequestVerifier(
  configuration: ClerkVerifierConfiguration,
): ClerkRequestVerifier {
  const client = createClerkClient({
    secretKey: configuration.secretKey,
    publishableKey: configuration.publishableKey,
    ...(configuration.jwtKey ? { jwtKey: configuration.jwtKey } : {}),
  });

  return new ClerkRequestVerifier(async (request) => {
    const result = await client.authenticateRequest(request, {
      acceptsToken: "session_token",
      ...(configuration.jwtKey ? { jwtKey: configuration.jwtKey } : {}),
    });

    if (!result.isAuthenticated) return result;

    const authorizedParty = result.toAuth()?.sessionClaims?.azp;
    if (!isClerkAuthorizedPartyAllowed(authorizedParty, configuration.authorizedParties)) {
      return { isAuthenticated: false, toAuth: () => null };
    }

    return result;
  });
}
