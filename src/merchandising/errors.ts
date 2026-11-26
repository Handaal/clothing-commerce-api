const errors = {
  SALE_NOT_FOUND: [404, "The requested sale does not exist."],
  INVALID_SALE: [422, "The sale request is not valid."],
  INVALID_STOREFRONT_CONTENT: [422, "The storefront content is not valid."],
} as const;

export type MerchandisingErrorCode = keyof typeof errors;

/** Typed, client-safe errors for catalog sales and storefront content. */
export class MerchandisingError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: MerchandisingErrorCode,
    message?: string,
  ) {
    super(message ?? errors[code][1]);
    this.name = "MerchandisingError";
    this.httpStatus = errors[code][0];
  }
}

/** Translate a sanctioned-RPC failure into a typed error; unknown failures stay opaque (500). */
export function merchandisingDatabaseError(
  error: { code?: string; message?: string },
  fallback: "INVALID_SALE" | "INVALID_STOREFRONT_CONTENT",
): Error {
  switch (error.code) {
    case "SL404":
      return new MerchandisingError("SALE_NOT_FOUND");
    case "SL422":
      return new MerchandisingError("INVALID_SALE", error.message ?? undefined);
    case "SC422":
      return new MerchandisingError("INVALID_STOREFRONT_CONTENT", error.message ?? undefined);
    case "22023":
    case "23514":
    case "23502":
    case "23503":
    case "22P02":
    case "22007":
      return new MerchandisingError(fallback);
    default:
      return new Error("An unexpected merchandising persistence error occurred.");
  }
}
