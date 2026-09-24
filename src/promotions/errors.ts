const errors = {
  PROMOTION_NOT_FOUND: [404, "The requested promotion or code does not exist."],
  PROMOTION_ECONOMICS_LOCKED: [
    409,
    "Promotion economics cannot change after the first redemption.",
  ],
  PROMOTION_CODE_CONFLICT: [409, "That promotion code is already in use."],
  INVALID_PROMOTION: [422, "The promotion request is not valid."],
} as const;

export class PromotionError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "PromotionError";
    this.httpStatus = errors[code][0];
  }
}

export function promotionDatabaseError(error: { code?: string }) {
  switch (error.code) {
    case "PR404":
      return new PromotionError("PROMOTION_NOT_FOUND");
    case "PR423":
      return new PromotionError("PROMOTION_ECONOMICS_LOCKED");
    case "23505":
      return new PromotionError("PROMOTION_CODE_CONFLICT");
    case "22023":
    case "23514":
    case "23502":
    case "23503":
    case "22P02":
      return new PromotionError("INVALID_PROMOTION");
    default:
      return new Error("An unexpected promotion persistence error occurred.");
  }
}
