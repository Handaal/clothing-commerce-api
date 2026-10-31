import { randomUUID } from "node:crypto";

import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import { PosTokenIssuer } from "../authentication/pos-token";
import type { PosAuthSigningConfiguration } from "../config/auth-environment";
import {
  type CreatePosLoginRequest,
  type PosLoginListResponse,
  type PosLoginRequest,
  type PosLoginResponse,
  type SetPosLoginPinRequest,
  type UpdatePosLoginRequest,
} from "../contracts";
import {
  DEFAULT_SCRYPT_PARAMS,
  deriveOnlinePinVerifier,
  verifyOnlinePin,
  type StaffPinVerifier,
} from "./offline-pin-crypto";
import { PosAuthError } from "./pos-auth-errors";
import type { PosAuthRepository } from "./pos-auth-repository";

const StaffManagePermission = "staff.manage";

// A constant decoy verifier so the unknown-username path runs ONE scrypt of the same cost as a real
// verify — timing equalisation that prevents distinguishing "no such user" from "wrong PIN" by latency.
const DECOY_VERIFIER: StaffPinVerifier = deriveOnlinePinVerifier(
  randomUUID(),
  DEFAULT_SCRYPT_PARAMS,
);

/**
 * The pos_pin authentication service. `login` is the public connected sign-in; the remaining methods are
 * the admin "Team" surface, each re-authorizing tenant-wide `staff.manage` before any write. The signing
 * configuration is null when the provider is dormant (no POS_AUTH_SIGNING_KEY), in which case `login`
 * rejects with a clear config error.
 */
export class PosAuthService {
  private readonly issuer: PosTokenIssuer | null;

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: PosAuthRepository,
    private readonly signing: PosAuthSigningConfiguration | null,
  ) {
    this.issuer = signing ? new PosTokenIssuer(new Uint8Array(signing.signingKey)) : null;
  }

  private authorize(context: AuthorizationContext) {
    return this.authorization.authorize(context, { permissionKey: StaffManagePermission });
  }

  /** Public connected sign-in. Unknown username and wrong PIN collapse to one indistinguishable failure. */
  async login(input: PosLoginRequest): Promise<PosLoginResponse> {
    if (this.issuer === null || this.signing === null) {
      throw new PosAuthError("POS_AUTH_NOT_CONFIGURED");
    }
    const resolved = await this.repository.begin(input.username);
    if (resolved.lockedUntil !== null) {
      // A locked window short-circuits WITHOUT recording another attempt, so a locked account cannot be
      // kept locked forever by a hammering attacker.
      throw new PosAuthError("ACCOUNT_LOCKED");
    }

    const account = resolved.account;
    // Always run exactly one scrypt (decoy when the user is unknown) before branching, for constant timing.
    const verified = verifyOnlinePin(input.pin, account?.verifier ?? DECOY_VERIFIER);
    const success = account !== null && verified;

    await this.repository.record(input.username, success);
    if (!success || account === null) {
      throw new PosAuthError("INVALID_CREDENTIALS");
    }

    const { token, expiresAt } = await this.issuer.issue(
      account.subject,
      this.signing.accessTtlSeconds,
    );
    return {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      operator: {
        membershipId: account.membershipId,
        tenantId: account.tenantId,
        username: account.username,
        displayName: account.displayName,
        role: account.posRole,
        permissions: [...account.posPermissions],
      },
    };
  }

  /** Admin: provision a pos_pin account (server-minted subject + online verifier + POS UI access). */
  async createLogin(context: AuthorizationContext, key: string, input: CreatePosLoginRequest) {
    const proof = await this.authorize(context);
    const replay = await this.repository.peekCommand(proof, key);
    if (replay !== null) return replay;

    // Server-minted opaque subject — never client-supplied — identical in spirit to the Clerk subject.
    const subject = randomUUID();
    const verifier = deriveOnlinePinVerifier(input.pin, DEFAULT_SCRYPT_PARAMS);
    return this.repository.createLogin(proof, key, subject, input, verifier);
  }

  async listLogins(context: AuthorizationContext): Promise<PosLoginListResponse> {
    const proof = await this.authorize(context);
    return { items: await this.repository.list(proof) };
  }

  async updateLogin(
    context: AuthorizationContext,
    membershipId: string,
    key: string,
    input: UpdatePosLoginRequest,
  ) {
    const proof = await this.authorize(context);
    return this.repository.update(proof, key, membershipId, input);
  }

  async setPin(
    context: AuthorizationContext,
    membershipId: string,
    key: string,
    input: SetPosLoginPinRequest,
  ) {
    const proof = await this.authorize(context);
    const verifier = deriveOnlinePinVerifier(input.pin, DEFAULT_SCRYPT_PARAMS);
    return this.repository.setPin(proof, key, membershipId, verifier);
  }
}
