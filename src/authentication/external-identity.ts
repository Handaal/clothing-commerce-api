import type { VerifiedExternalIdentity } from "../authorization/model";

/** Verifies provider credentials and returns only server-derived identity provenance. */
export interface ExternalIdentityVerifier {
  verifyRequest(request: Request): Promise<VerifiedExternalIdentity>;
}
