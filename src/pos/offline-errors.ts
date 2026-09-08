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
  | "IDEMPOTENCY_CONFLICT";

const status: Record<OfflinePosErrorCode, 401 | 403 | 404 | 409 | 422> = {
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
  IDEMPOTENCY_CONFLICT: 409,
};

const message: Record<OfflinePosErrorCode, string> = {
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
  IDEMPOTENCY_CONFLICT: "The sync command identity was reused with different signed intent.",
};

export class OfflinePosError extends Error {
  readonly httpStatus: 401 | 403 | 404 | 409 | 422;
  constructor(readonly code: OfflinePosErrorCode) {
    super(message[code]);
    this.name = "OfflinePosError";
    this.httpStatus = status[code];
  }
}
