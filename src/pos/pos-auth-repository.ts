import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  StaffDetailSchema,
  type CreatePosLoginRequest,
  type UpdatePosLoginRequest,
} from "../contracts";
import type { StaffPinVerifier } from "./offline-pin-crypto";
import { posAuthDatabaseError } from "./pos-auth-errors";

/**
 * Service-role data access for the pos_pin provider. It serves two kinds of caller:
 *   • the PUBLIC login path (`begin` / `record`) — pre-tenant, pre-auth by nature (the username is
 *     instance-global-unique), so these take no proof; and
 *   • the ADMIN management path (`createLogin` / `list` / `update` / `setPin`) — authorized at the service
 *     layer (tenant-wide staff.manage) and tenant-filtered via the proof.
 * All calls go through the same security-definer RPCs; nothing here trusts a client-supplied tenant/actor.
 */

// The single row `pos_login_begin` always returns: lockout state plus a (nullable) resolved account.
const PosLoginBeginRowSchema = z.object({
  locked: z.boolean(),
  locked_until: z.string().nullable(),
  failed_count: z.number().int(),
  provider_subject: z.string().nullable(),
  tenant_id: z.string().uuid().nullable(),
  membership_id: z.string().uuid().nullable(),
  display_name: z.string().nullable(),
  username: z.string().nullable(),
  pos_role: z.enum(["admin", "cashier"]).nullable(),
  pos_permissions: z.array(z.string()).nullable(),
  salt_base64: z.string().nullable(),
  hash_base64: z.string().nullable(),
  scrypt_n: z.number().int().nullable(),
  scrypt_r: z.number().int().nullable(),
  scrypt_p: z.number().int().nullable(),
  key_length: z.number().int().nullable(),
});

const PosLoginSummaryRowSchema = z.object({
  membership_id: z.string().uuid(),
  username: z.string(),
  display_name: z.string().nullable(),
  status: z.enum(["invited", "active", "suspended", "deactivated"]),
  pos_role: z.enum(["admin", "cashier"]),
  pos_permissions: z.array(z.string()),
});

export interface ResolvedPosLogin {
  readonly lockedUntil: Date | null;
  readonly account: {
    readonly subject: string;
    readonly tenantId: string;
    readonly membershipId: string;
    readonly displayName: string;
    readonly username: string;
    readonly posRole: "admin" | "cashier";
    readonly posPermissions: readonly string[];
    readonly verifier: StaffPinVerifier;
  } | null;
}

export class PosAuthRepository {
  constructor(private readonly client: SupabaseClient) {}

  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }

  private actor(proof: AuthorizedOperationContext) {
    return proof.authorization.membership.id;
  }

  /** Public login step 1: resolve lockout + (nullable) account/verifier for a submitted username. */
  async begin(username: string): Promise<ResolvedPosLogin> {
    const { data, error } = await this.client
      .schema("staff_private")
      .rpc("pos_login_begin", { p_username: username });
    if (error) throw posAuthDatabaseError(error);
    const rows = z.array(PosLoginBeginRowSchema).parse(data);
    const row = rows[0];
    const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
    const resolvable =
      row.provider_subject !== null &&
      row.tenant_id !== null &&
      row.membership_id !== null &&
      row.pos_role !== null &&
      row.salt_base64 !== null &&
      row.hash_base64 !== null &&
      row.scrypt_n !== null &&
      row.scrypt_r !== null &&
      row.scrypt_p !== null &&
      row.key_length !== null;
    return {
      lockedUntil: row.locked ? lockedUntil : null,
      account: resolvable
        ? {
            subject: row.provider_subject!,
            tenantId: row.tenant_id!,
            membershipId: row.membership_id!,
            displayName: row.display_name ?? row.username ?? "",
            username: row.username ?? username,
            posRole: row.pos_role!,
            posPermissions: row.pos_permissions ?? [],
            verifier: {
              algorithm: "scrypt",
              saltBase64: row.salt_base64!,
              hashBase64: row.hash_base64!,
              n: row.scrypt_n!,
              r: row.scrypt_r!,
              p: row.scrypt_p!,
              keyLength: row.key_length!,
            },
          }
        : null,
    };
  }

  /** Public login step 2: record the attempt outcome (clears on success, throttles on failure). */
  async record(username: string, success: boolean): Promise<void> {
    const { error } = await this.client
      .schema("staff_private")
      .rpc("pos_login_record", { p_username: username, p_success: success });
    if (error) throw posAuthDatabaseError(error);
  }

  /** Admin: provision a pos_pin account for an already-minted server subject + online verifier. */
  async createLogin(
    proof: AuthorizedOperationContext,
    key: string,
    subject: string,
    input: CreatePosLoginRequest,
    verifier: StaffPinVerifier,
  ) {
    const { data, error } = await this.client.schema("staff_private").rpc("create_pos_login", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_key: key,
      p_subject: subject,
      p_username: input.username,
      p_display_name: input.displayName,
      p_role: input.roleId,
      p_scope: input.accessScopeId,
      p_pos_role: input.posRole,
      p_pos_permissions: input.posPermissions,
      p_salt: verifier.saltBase64,
      p_hash: verifier.hashBase64,
      p_n: verifier.n,
      p_r: verifier.r,
      p_p: verifier.p,
      p_key_length: verifier.keyLength,
    });
    if (error) throw posAuthDatabaseError(error);
    return StaffDetailSchema.parse(data);
  }

  async peekCommand(proof: AuthorizedOperationContext, key: string) {
    const { data, error } = await this.client.schema("staff_private").rpc("peek_command", {
      p_tenant: this.tenant(proof),
      p_key: key,
    });
    if (error) throw posAuthDatabaseError(error);
    return data === null ? null : StaffDetailSchema.parse(data);
  }

  async list(proof: AuthorizedOperationContext) {
    const { data, error } = await this.client.schema("staff_private").rpc("list_pos_logins", {
      p_tenant: this.tenant(proof),
    });
    if (error) throw posAuthDatabaseError(error);
    const rows = z.array(PosLoginSummaryRowSchema).parse(data);
    return rows.map((row) => ({
      membershipId: row.membership_id,
      username: row.username,
      displayName: row.display_name,
      status: row.status,
      posRole: row.pos_role,
      posPermissions: row.pos_permissions,
    }));
  }

  async update(
    proof: AuthorizedOperationContext,
    key: string,
    membershipId: string,
    input: UpdatePosLoginRequest,
  ) {
    const { data, error } = await this.client.schema("staff_private").rpc("update_pos_login", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_key: key,
      p_membership: membershipId,
      p_display_name: input.displayName ?? null,
      p_pos_role: input.posRole,
      p_pos_permissions: input.posPermissions,
    });
    if (error) throw posAuthDatabaseError(error);
    return StaffDetailSchema.parse(data);
  }

  async setPin(
    proof: AuthorizedOperationContext,
    key: string,
    membershipId: string,
    verifier: StaffPinVerifier,
  ) {
    const { data, error } = await this.client.schema("staff_private").rpc("set_pos_login_pin", {
      p_tenant: this.tenant(proof),
      p_actor: this.actor(proof),
      p_key: key,
      p_membership: membershipId,
      p_salt: verifier.saltBase64,
      p_hash: verifier.hashBase64,
      p_n: verifier.n,
      p_r: verifier.r,
      p_p: verifier.p,
      p_key_length: verifier.keyLength,
    });
    if (error) throw posAuthDatabaseError(error);
    return z.object({ membershipId: z.string().uuid(), updatedAt: z.string() }).parse(data);
  }
}

export function createPosAuthRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new PosAuthRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
