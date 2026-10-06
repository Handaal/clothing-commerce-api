const errors = {
  ALREADY_CLOCKED_IN: [409, "The member is already clocked in."],
  NOT_CLOCKED_IN: [409, "The member is not currently clocked in."],
  ENTRY_NOT_FOUND: [404, "The attendance entry does not exist."],
  ALREADY_ON_LEAVE: [409, "The member is already on leave."],
  NOT_ON_LEAVE: [409, "The member is not currently on leave."],
  ADJUSTMENT_NOT_FOUND: [404, "The pay adjustment does not exist."],
  INVALID_ATTENDANCE: [422, "The attendance request is not valid."],
} as const;
export class AttendanceError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "AttendanceError";
    this.httpStatus = errors[code][0];
  }
}
export function attendanceDatabaseError(error: { code?: string }) {
  switch (error.code) {
    case "AT409":
      return new AttendanceError("ALREADY_CLOCKED_IN");
    case "AT404":
      return new AttendanceError("NOT_CLOCKED_IN");
    case "AE404":
      return new AttendanceError("ENTRY_NOT_FOUND");
    case "LV409":
      return new AttendanceError("ALREADY_ON_LEAVE");
    case "LV404":
      return new AttendanceError("NOT_ON_LEAVE");
    case "AD404":
      return new AttendanceError("ADJUSTMENT_NOT_FOUND");
    case "22004": // required field missing
    case "23503": // branch/membership FK violation (unknown/foreign reference)
    case "22023":
    case "23514":
      return new AttendanceError("INVALID_ATTENDANCE");
    default:
      return new Error("An unexpected attendance persistence error occurred.");
  }
}
