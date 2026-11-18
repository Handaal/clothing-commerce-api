export type OfflinePosErrorCode =
  | "DEVICE_NOT_FOUND"
  | "DEVICE_REVOKED"
  | "DEVICE_ENROLLMENT_CONFLICT"
  | "OFFLINE_DISABLED"
  | "OFFLINE_LOCATION_LEASE_CONFLICT"
  | "OFFLINE_GRANT_NOT_FOUND"
  | "OFFLINE_GRANT_INVALID"
  | "OFFLINE_GRANT_EXPIRED"
  | "OFFLINE_LIMIT_EXCEEDED"
  | "OFFLINE_SIGNATURE_INVALID"
  | "OFFLINE_PIN_NOT_CONFIGURED"
  | "OFFLINE_PIN_REENROLLMENT_REQUIRED"
  | "OFFLINE_PIN_ENROLLMENT_DENIED"
  | "OFFLINE_PIN_STAFF_NOT_FOUND"
  | "OFFLINE_PIN_STAFF_INACTIVE"
  | "OFFLINE_PIN_ESCALATION_DENIED"
  | "OFFLINE_PIN_DISABLED"
  | "OFFLINE_PIN_STEP_UP_FAILED"
  | "OFFLINE_INTENT_DISABLED"
  | "OFFLINE_INTENT_DEPENDENCY_MISSING"
  | "STOCK_GRANT_NOT_FOUND"
  | "STOCK_GRANT_OPEN"
  | "STOCK_GRANT_INSUFFICIENT"
  | "OFFLINE_RETURN_BUDGET_MISSING"
  | "OVERRIDE_PASSWORD_NOT_CONFIGURED"
  | "OVERRIDE_PASSWORD_REJECTED"
  | "OVERRIDE_PASSWORD_NOT_ALLOWED"
  | "OVERRIDE_PASSWORD_NOT_SET"
  | "OFFLINE_SALE_ORDINAL_CONFLICT"
  | "OFFLINE_SALE_HOLD_INVALID"
  | "OFFLINE_RETURNS_DISABLED"
  | "IDEMPOTENCY_CONFLICT";

const status: Record<OfflinePosErrorCode, 401 | 403 | 404 | 409 | 422 | 503> = {
  DEVICE_NOT_FOUND: 404,
  DEVICE_REVOKED: 409,
  DEVICE_ENROLLMENT_CONFLICT: 409,
  OFFLINE_DISABLED: 403,
  OFFLINE_LOCATION_LEASE_CONFLICT: 409,
  OFFLINE_GRANT_NOT_FOUND: 404,
  OFFLINE_GRANT_INVALID: 422,
  OFFLINE_GRANT_EXPIRED: 409,
  OFFLINE_LIMIT_EXCEEDED: 422,
  OFFLINE_SIGNATURE_INVALID: 401,
  OFFLINE_PIN_NOT_CONFIGURED: 503,
  OFFLINE_PIN_REENROLLMENT_REQUIRED: 409,
  OFFLINE_PIN_ENROLLMENT_DENIED: 403,
  OFFLINE_PIN_STAFF_NOT_FOUND: 404,
  OFFLINE_PIN_STAFF_INACTIVE: 409,
  OFFLINE_PIN_ESCALATION_DENIED: 403,
  OFFLINE_PIN_DISABLED: 409,
  OFFLINE_PIN_STEP_UP_FAILED: 401,
  OFFLINE_INTENT_DISABLED: 403,
  OFFLINE_INTENT_DEPENDENCY_MISSING: 409,
  STOCK_GRANT_NOT_FOUND: 404,
  STOCK_GRANT_OPEN: 409,
  STOCK_GRANT_INSUFFICIENT: 409,
  OFFLINE_RETURN_BUDGET_MISSING: 409,
  OVERRIDE_PASSWORD_NOT_CONFIGURED: 503,
  OVERRIDE_PASSWORD_REJECTED: 422,
  OVERRIDE_PASSWORD_NOT_ALLOWED: 403,
  OVERRIDE_PASSWORD_NOT_SET: 404,
  OFFLINE_SALE_ORDINAL_CONFLICT: 409,
  OFFLINE_SALE_HOLD_INVALID: 422,
  OFFLINE_RETURNS_DISABLED: 409,
  IDEMPOTENCY_CONFLICT: 409,
};

const message: Record<OfflinePosErrorCode, string> = {
  OFFLINE_PIN_REENROLLMENT_REQUIRED:
    "Manager-set (server-sealed) offline PINs are retired. Each staff member enrols their own offline PIN on the till while online.",
  OFFLINE_PIN_ENROLLMENT_DENIED:
    "Offline PIN enrollment needs an active device assigned to this register and a staff member allowed to sell there.",
  DEVICE_NOT_FOUND: "The POS device does not exist.",
  DEVICE_REVOKED: "The POS device is revoked.",
  DEVICE_ENROLLMENT_CONFLICT: "The installation or credential conflicts with an existing device.",
  OFFLINE_DISABLED: "Offline selling is not enabled for this register.",
  OFFLINE_LOCATION_LEASE_CONFLICT:
    "Another device holds active offline authority for this inventory location.",
  OFFLINE_GRANT_NOT_FOUND: "The offline grant does not exist.",
  OFFLINE_GRANT_INVALID: "The offline sale is not authorized by its grant.",
  OFFLINE_GRANT_EXPIRED: "The offline sale was accepted outside the grant window.",
  OFFLINE_LIMIT_EXCEEDED: "The offline sale exceeds its grant policy.",
  OFFLINE_SIGNATURE_INVALID: "The offline sale signature is invalid.",
  OFFLINE_PIN_NOT_CONFIGURED: "Offline PIN credentials are not configured on this server.",
  OFFLINE_PIN_DISABLED:
    "Offline PIN sign-in is not enabled on this server (POS_OFFLINE_PIN_V2). Nothing was enrolled.",
  OFFLINE_PIN_STEP_UP_FAILED:
    "Confirm your own POS username and current sign-in PIN to set up an offline PIN. Nothing was enrolled.",
  OFFLINE_PIN_STAFF_NOT_FOUND: "The staff member does not exist.",
  OFFLINE_PIN_STAFF_INACTIVE: "The staff member is not active.",
  OFFLINE_PIN_ESCALATION_DENIED:
    "Setting this PIN would grant offline access to permissions the caller does not hold.",
  OFFLINE_INTENT_DISABLED: "This offline operation is not enabled for this register.",
  OFFLINE_INTENT_DEPENDENCY_MISSING:
    "The offline intent depends on another intent that has not been received yet.",
  STOCK_GRANT_NOT_FOUND: "The offline stock grant does not exist for this register.",
  STOCK_GRANT_OPEN:
    "The register still holds an open offline stock grant, or not all of its offline sales are synchronized yet.",
  STOCK_GRANT_INSUFFICIENT: "The requested offline stock exceeds the free POS stock.",
  OFFLINE_RETURN_BUDGET_MISSING:
    "Offline returns need a per-grant refund budget in the return settings before a grant can be issued.",
  OVERRIDE_PASSWORD_NOT_CONFIGURED: "POS override passwords are not configured on this server.",
  OVERRIDE_PASSWORD_REJECTED:
    "The override password must be at least 10 characters and must not contain your username or PIN or be a common password.",
  OVERRIDE_PASSWORD_NOT_ALLOWED:
    "Only accounts whose permissions cover voucher redemption or refunds can set an override password.",
  OVERRIDE_PASSWORD_NOT_SET: "No override password is set for this staff member.",
  OFFLINE_SALE_ORDINAL_CONFLICT:
    "This offline sale ordinal already has a terminal record (synchronized or held for reconciliation).",
  OFFLINE_SALE_HOLD_INVALID:
    "The hold does not match the signed sale, names an unsupported reason, or the customer it depends on exists.",
  OFFLINE_RETURNS_DISABLED:
    "Returns are online-only. Reconnect and process the return online; nothing was recorded.",
  IDEMPOTENCY_CONFLICT: "The sync command identity was reused with different signed intent.",
};

export class OfflinePosError extends Error {
  readonly httpStatus: 401 | 403 | 404 | 409 | 422 | 503;
  constructor(readonly code: OfflinePosErrorCode) {
    super(message[code]);
    this.name = "OfflinePosError";
    this.httpStatus = status[code];
  }
}
