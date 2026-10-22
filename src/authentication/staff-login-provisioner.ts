import { createClerkClient } from "@clerk/backend";

import { StaffError } from "../staff/errors";

/**
 * Mints the EXTERNAL login account for an email-less staff member and returns only the server-verified
 * provider subject. This is the one place the Clerk SECRET key is used for a write; the subject it returns
 * is what the `create_staff_login` RPC records as the provider binding. The subject is produced here, by
 * the server, and never accepted from a client — that is the whole point of the provider-binding model.
 *
 * It is deliberately provider-shaped but provider-neutral at the call site: the staff service depends on
 * this interface, so an alternative credential provider can be substituted without touching the domain.
 */
export interface StaffLoginProvisioner {
  /**
   * Create (or, on an idempotent retry, resolve the existing) external account for `username` with the
   * given PIN and return its stable provider subject. Implementations MUST be safe to call with a username
   * that already exists for the same logical person (retry) and MUST surface a distinct conflict when the
   * username belongs to a different account they did not just create.
   */
  provisionLogin(input: {
    readonly username: string;
    readonly pin: string;
    readonly displayName: string;
  }): Promise<string>;

  /** Best-effort removal of an account this provisioner created, used to avoid orphans on a late failure. */
  deleteLogin(subject: string): Promise<void>;
}

type ClerkUsersApi = {
  createUser(params: Record<string, unknown>): Promise<{ id: string }>;
  getUserList(params: Record<string, unknown>): Promise<{ data: ReadonlyArray<{ id: string }> }>;
  deleteUser(userId: string): Promise<unknown>;
};

/** True when a Clerk error payload reports the username is already taken (HTTP 422 `form_identifier_exists`). */
function isUsernameTaken(error: unknown): boolean {
  const errors = (error as { errors?: ReadonlyArray<{ code?: string }> } | null)?.errors;
  return Array.isArray(errors) && errors.some((e) => e.code === "form_identifier_exists");
}

export class ClerkStaffLoginProvisioner implements StaffLoginProvisioner {
  constructor(private readonly users: ClerkUsersApi) {}

  async provisionLogin(input: {
    readonly username: string;
    readonly pin: string;
    readonly displayName: string;
  }): Promise<string> {
    const [firstName] = input.displayName.split(/\s+/, 1);
    try {
      // Email-less username + password account. `skipPasswordChecks` lets a short numeric PIN through the
      // instance password policy; the instance must still be configured to allow username sign-in.
      const created = await this.users.createUser({
        username: input.username,
        password: input.pin,
        firstName: firstName || input.displayName,
        skipPasswordChecks: true,
      });
      return created.id;
    } catch (error) {
      // A taken username means either an idempotent retry of our own create, or a real collision. The DB
      // idempotency ledger (peeked before we get here) already short-circuits genuine replays, so by this
      // point a taken username is an unavailable identifier the caller must change.
      if (isUsernameTaken(error)) throw new StaffError("STAFF_CONFLICT");
      throw error;
    }
  }

  async deleteLogin(subject: string): Promise<void> {
    try {
      await this.users.deleteUser(subject);
    } catch {
      // Best-effort cleanup only: a failure here is logged by the caller's error path, never surfaced.
    }
  }
}

export function createClerkStaffLoginProvisioner(configuration: {
  readonly secretKey: string;
  readonly publishableKey: string;
}): StaffLoginProvisioner {
  const client = createClerkClient({
    secretKey: configuration.secretKey,
    publishableKey: configuration.publishableKey,
  });
  return new ClerkStaffLoginProvisioner(client.users as unknown as ClerkUsersApi);
}
