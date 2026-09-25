const errors = {
  INVALID_REPORT_QUERY: [422, "The report query is not valid."],
  TENANT_NOT_FOUND: [404, "The tenant could not be resolved for reporting."],
} as const;

export class ReportingError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "ReportingError";
    this.httpStatus = errors[code][0];
  }
}

export function reportingDatabaseError(error: { code?: string }) {
  switch (error.code) {
    case "RP404":
      return new ReportingError("TENANT_NOT_FOUND");
    case "22023":
    case "22007": // invalid date text
      return new ReportingError("INVALID_REPORT_QUERY");
    default:
      return new Error("An unexpected reporting persistence error occurred.");
  }
}
