import { AuthorizationContextResolver } from "../authorization/context-resolver";
import { AuthorizationService } from "../authorization/authorization-service";
import { createSupabaseAuthorizationRepository } from "../authorization/supabase-authorization-repository";
import {
  readClerkVerifierConfiguration,
  readPosAuthSigningConfiguration,
  readSupabasePrivilegedConfiguration,
} from "../config/auth-environment";
import { createClerkRequestVerifier } from "./clerk-request-verifier";
import { CompositeExternalIdentityVerifier } from "./composite-external-identity-verifier";
import { PosTokenVerifier } from "./pos-token";

/**
 * Production composition root for staff/admin requests. Creating it validates all server-only
 * configuration. No secret or privileged database client escapes this boundary.
 *
 * The request verifier is a composite: POS-native (`pos_pin`) access tokens resolve to the POS provider,
 * everything else to Clerk. The POS provider is dormant (and the composite falls straight through to
 * Clerk) when `POS_AUTH_SIGNING_KEY` is unset, so mobile/admin deployments are unaffected.
 */
export function createServerAuthorizationBoundary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const clerkVerifier = createClerkRequestVerifier(readClerkVerifierConfiguration(environment));
  const posSigning = readPosAuthSigningConfiguration(environment);
  const posVerifier = posSigning
    ? new PosTokenVerifier(new Uint8Array(posSigning.signingKey))
    : null;
  const verifier = new CompositeExternalIdentityVerifier(clerkVerifier, posVerifier);
  const repository = createSupabaseAuthorizationRepository(
    readSupabasePrivilegedConfiguration(environment),
  );

  return {
    contextResolver: new AuthorizationContextResolver(verifier, repository),
    authorizationService: new AuthorizationService(repository),
  } as const;
}
