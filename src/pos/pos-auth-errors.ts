export type PosAuthErrorCode =
  // Collapsed single failure for unknown username OR wrong PIN — the transport never distinguishes them.
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  // The pos_pin provider is dormant because POS_AUTH_SIGNING_KEY is unset on this deployment.
  | "POS_AUTH_NOT_CONFIGURED"
  | "POS_LOGIN_NOT_FOUND"
  | "POS_LOGIN_ESCALATION_DENIED"
  | "IDEMPOTENCY_CONFLICT";

const status: Record<PosAuthErrorCode, 401 | 403 | 404 | 409 | 429 | 503> = {
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  POS_AUTH_NOT_CONFIGURED: 503,
  POS_LOGIN_NOT_FOUND: 404,
  POS_LOGIN_ESCALATION_DENIED: 403,
  IDEMPOTENCY_CONFLICT: 409,
};

const message: Record<PosAuthErrorCode, string> = {
  INVALID_CREDENTIALS: "The username or PIN is incorrect.",
  ACCOUNT_LOCKED: "Too many failed attempts. Try again shortly.",
  POS_AUTH_NOT_CONFIGURED: "POS-native sign-in is not configured on this server.",
  POS_LOGIN_NOT_FOUND: "The POS login does not exist.",
  POS_LOGIN_ESCALATION_DENIED: "This change would affect permissions the caller does not hold.",
  IDEMPOTENCY_CONFLICT: "The request key was reused with a different payload.",
};

export class PosAuthError extends Error {
  readonly httpStatus: 401 | 403 | 404 | 409 | 429 | 503;
  constructor(readonly code: PosAuthErrorCode) {
    super(message[code]);
    this.name = "PosAuthError";
    this.httpStatus = status[code];
  }
}

/** Map a Supabase RPC error to a typed PosAuthError, mirroring the SQLSTATE codes the RPCs raise. */
export function posAuthDatabaseError(error: { code?: string; message?: string }): PosAuthError {
  switch (error.code) {
    case "ST404":
      return new PosAuthError("POS_LOGIN_NOT_FOUND");
    case "ST403":
      return new PosAuthError("POS_LOGIN_ESCALATION_DENIED");
    case "ID409":
      // begin_command raises ID409 when a key is reused with a different intent.
      return new PosAuthError("IDEMPOTENCY_CONFLICT");
    default:
      throw Object.assign(new Error(error.message ?? "POS auth database error"), { cause: error });
  }
}
