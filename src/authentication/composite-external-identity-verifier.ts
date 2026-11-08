import type { VerifiedExternalIdentity } from "../authorization/model";
import type { ExternalIdentityVerifier } from "./external-identity";
import { NotAPosToken, PosTokenVerifier } from "./pos-token";

/**
 * Dispatches a request to the right authentication provider without changing anything downstream of
 * `{ provider, subject }`:
 *
 *   • a bearer JWT with `iss === "pos"` → PosTokenVerifier → { provider: "pos_pin", subject }
 *   • anything else (a Clerk session token) → ClerkRequestVerifier → { provider: "clerk", subject }
 *
 * The POS verifier runs first and signals `NotAPosToken` when the request is not POS-shaped; only then do
 * we fall through to Clerk. A POS-shaped but invalid token is a hard failure from the POS verifier and is
 * NOT retried against Clerk. Mobile/admin/storefront keep using Clerk, untouched.
 *
 * When the POS provider is dormant (no `POS_AUTH_SIGNING_KEY`), `posVerifier` is absent and every request
 * routes straight to Clerk — identical to today's behaviour.
 */
export class CompositeExternalIdentityVerifier implements ExternalIdentityVerifier {
  constructor(
    private readonly clerkVerifier: ExternalIdentityVerifier,
    private readonly posVerifier: PosTokenVerifier | null,
  ) {}

  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    if (this.posVerifier !== null) {
      try {
        return await this.posVerifier.verifyRequest(request);
      } catch (error) {
        // Not a POS token → let Clerk try. Any other error (invalid POS token) propagates unchanged.
        if (!(error instanceof NotAPosToken)) throw error;
      }
    }
    return this.clerkVerifier.verifyRequest(request);
  }
}
