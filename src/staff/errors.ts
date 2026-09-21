const errors = {
  STAFF_NOT_FOUND: [
    404,
    "The requested staff membership, role, scope or assignment does not exist.",
  ],
  STAFF_CONFLICT: [409, "The staff membership or assignment is in a conflicting state."],
  LAST_STAFF_ADMIN: [
    409,
    "The operation would remove the last staff administrator for the tenant.",
  ],
  STAFF_PRIVILEGE_ESCALATION: [
    403,
    "The assignment would grant authority the caller does not hold.",
  ],
  IDENTITY_INACTIVE: [409, "The linked identity is not active."],
  INVALID_STAFF: [422, "The staff request is not valid."],
  IDEMPOTENCY_CONFLICT: [409, "The idempotency key was reused with a different payload."],
} as const;

export class StaffError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "StaffError";
    this.httpStatus = errors[code][0];
  }
}

export function staffDatabaseError(error: { code?: string }) {
  switch (error.code) {
    case "ST404":
      return new StaffError("STAFF_NOT_FOUND");
    case "ST409":
      return new StaffError("STAFF_CONFLICT");
    case "ST412":
      return new StaffError("LAST_STAFF_ADMIN");
    case "ST403":
      return new StaffError("STAFF_PRIVILEGE_ESCALATION");
    case "ST423":
      return new StaffError("IDENTITY_INACTIVE");
    case "ID409":
      return new StaffError("IDEMPOTENCY_CONFLICT");
    case "23505":
      return new StaffError("STAFF_CONFLICT");
    case "22023":
    case "23514":
      return new StaffError("INVALID_STAFF");
    default:
      return new Error("An unexpected staff persistence error occurred.");
  }
}
