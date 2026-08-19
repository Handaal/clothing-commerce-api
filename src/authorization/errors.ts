export const authorizationErrorCodes = [
  "UNAUTHENTICATED",
  "PROVIDER_BINDING_MISSING",
  "PROVIDER_BINDING_INVALID",
  "IDENTITY_INACTIVE",
  "TENANT_ACCESS_DENIED",
  "TENANT_SUSPENDED",
  "TENANT_INACTIVE",
  "MEMBERSHIP_INACTIVE",
  "DEVICE_REVOKED",
  "DEVICE_INACTIVE",
  "PERMISSION_DENIED",
  "SCOPE_DENIED",
  "PROTECTED_ROLE_MUTATION_DENIED",
  "AUTHORIZATION_PROOF_INVALID",
  "AUTHORIZATION_STATE_INVALID",
] as const;

export type AuthorizationErrorCode = (typeof authorizationErrorCodes)[number];

const safeMessages: Record<AuthorizationErrorCode, string> = {
  UNAUTHENTICATED: "Authentication is required.",
  PROVIDER_BINDING_MISSING: "The authenticated identity is not linked to this platform.",
  PROVIDER_BINDING_INVALID: "The authenticated identity link is not valid.",
  IDENTITY_INACTIVE: "This identity is not active.",
  TENANT_ACCESS_DENIED: "Access to the requested tenant or resource is denied.",
  TENANT_SUSPENDED: "The requested tenant is suspended.",
  TENANT_INACTIVE: "The requested tenant is not active.",
  MEMBERSHIP_INACTIVE: "The tenant membership is not active.",
  DEVICE_REVOKED: "The authenticated device is revoked.",
  DEVICE_INACTIVE: "The authenticated device is not active.",
  PERMISSION_DENIED: "The requested operation is not permitted.",
  SCOPE_DENIED: "The requested resource is outside the permitted scope.",
  PROTECTED_ROLE_MUTATION_DENIED: "The protected role cannot be changed by a tenant operation.",
  AUTHORIZATION_PROOF_INVALID: "A valid authorization proof is required.",
  AUTHORIZATION_STATE_INVALID: "Authorization state is invalid.",
};

export class AuthorizationError extends Error {
  readonly httpStatus: 401 | 403;

  constructor(readonly code: AuthorizationErrorCode) {
    super(safeMessages[code]);
    this.name = "AuthorizationError";
    this.httpStatus = code === "UNAUTHENTICATED" ? 401 : 403;
  }
}

export function authorizationErrorResponse(error: AuthorizationError) {
  return {
    status: error.httpStatus,
    body: {
      error: {
        code: error.code,
        message: error.message,
      },
    },
  } as const;
}
