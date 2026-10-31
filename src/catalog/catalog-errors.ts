/**
 * Stable catalog write errors. Authorization failures use AuthorizationError (from src/authorization)
 * and are never duplicated here. Raw PostgreSQL SQLSTATEs and database messages never escape the
 * repository; the sanctioned catalog functions raise internal CT-prefixed and ID409 signals that
 * supabase-catalog-write-repository maps to these codes.
 */
export const catalogErrorCodes = [
  "PRODUCT_NOT_FOUND",
  "VARIANT_NOT_FOUND",
  "MEDIA_NOT_FOUND",
  "COLLECTION_NOT_FOUND",
  "SLUG_CONFLICT",
  "STYLE_CODE_CONFLICT",
  "SKU_CONFLICT",
  "INVALID_LIFECYCLE_TRANSITION",
  "PRODUCT_NOT_PUBLISHABLE",
  "PRODUCT_PUBLISHED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_INPUT",
] as const;

export type CatalogErrorCode = (typeof catalogErrorCodes)[number];

const safeMessages: Record<CatalogErrorCode, string> = {
  PRODUCT_NOT_FOUND: "The requested product does not exist.",
  VARIANT_NOT_FOUND: "The requested variant does not exist.",
  MEDIA_NOT_FOUND: "The requested product media does not exist.",
  COLLECTION_NOT_FOUND: "The requested collection does not exist.",
  SLUG_CONFLICT: "A product with this slug already exists.",
  STYLE_CODE_CONFLICT: "A product with this style code already exists.",
  SKU_CONFLICT: "A variant with this SKU already exists.",
  INVALID_LIFECYCLE_TRANSITION: "The product cannot make this lifecycle transition.",
  PRODUCT_NOT_PUBLISHABLE: "The product is not eligible to be published.",
  PRODUCT_PUBLISHED: "Unpublish the product from the Storefront before this change.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was reused with a different payload.",
  INVALID_INPUT: "The request is not valid.",
};

const httpStatusByCode: Record<CatalogErrorCode, 400 | 404 | 409 | 422> = {
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  COLLECTION_NOT_FOUND: 404,
  SLUG_CONFLICT: 409,
  STYLE_CODE_CONFLICT: 409,
  SKU_CONFLICT: 409,
  INVALID_LIFECYCLE_TRANSITION: 409,
  PRODUCT_NOT_PUBLISHABLE: 422,
  PRODUCT_PUBLISHED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_INPUT: 400,
};

export class CatalogError extends Error {
  readonly httpStatus: 400 | 404 | 409 | 422;

  constructor(readonly code: CatalogErrorCode) {
    super(safeMessages[code]);
    this.name = "CatalogError";
    this.httpStatus = httpStatusByCode[code];
  }
}
