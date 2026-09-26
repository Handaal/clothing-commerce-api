const errors = {
  SETTINGS_NOT_FOUND: [404, "The requested settings resource does not exist."],
  INVALID_SETTINGS: [422, "The settings request is not valid."],
  SETTINGS_CODE_CONFLICT: [409, "The code is already in use."],
  CURRENCY_LOCKED: [409, "The currency cannot change once commercial history exists."],
  IMMUTABLE_FIELD: [409, "That field is immutable after creation."],
  DEVICE_CONFLICT: [409, "The device or assignment is in a conflicting state."],
  IDEMPOTENCY_CONFLICT: [409, "The idempotency key was reused with a different payload."],
} as const;

export class SettingsError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "SettingsError";
    this.httpStatus = errors[code][0];
  }
}

/** Maps a Postgres/RPC error code to the frozen settings error taxonomy. */
export function settingsDatabaseError(error: { code?: string }) {
  switch (error.code) {
    case "ST404":
      return new SettingsError("SETTINGS_NOT_FOUND");
    case "SC409":
      return new SettingsError("CURRENCY_LOCKED");
    case "SI409":
      return new SettingsError("IMMUTABLE_FIELD");
    case "ST409":
      return new SettingsError("DEVICE_CONFLICT");
    case "ID409":
      return new SettingsError("IDEMPOTENCY_CONFLICT");
    case "23505":
      return new SettingsError("SETTINGS_CODE_CONFLICT");
    case "22023":
    case "23502":
    case "23503":
    case "23514":
      return new SettingsError("INVALID_SETTINGS");
    default:
      return new Error("An unexpected settings persistence error occurred.");
  }
}
