import { AuthorizationContextResolver } from "../authorization/context-resolver";
import { AuthorizationService } from "../authorization/authorization-service";
import { createSupabaseAuthorizationRepository } from "../authorization/supabase-authorization-repository";
import {
  readClerkVerifierConfiguration,
  readSupabasePrivilegedConfiguration,
} from "../config/auth-environment";
import { createClerkRequestVerifier } from "./clerk-request-verifier";

/**
 * Production composition root for staff/admin requests. Creating it validates all server-only
 * configuration. No secret or privileged database client escapes this boundary.
 */
export function createServerAuthorizationBoundary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const verifier = createClerkRequestVerifier(readClerkVerifierConfiguration(environment));
  const repository = createSupabaseAuthorizationRepository(
    readSupabasePrivilegedConfiguration(environment),
  );

  return {
    contextResolver: new AuthorizationContextResolver(verifier, repository),
    authorizationService: new AuthorizationService(repository),
  } as const;
}
