import type { CatalogImage, CatalogImageInput } from "../contracts/management/catalog-images";
import { CatalogError } from "./catalog-errors";
import { CATALOG_MEDIA_BUCKET } from "./catalog-management-service";

/**
 * A collection cover / category image must be one this tenant obtained from the catalog-image upload
 * intent: the catalog media bucket, under "<tenantId>/catalog/". The database re-checks the prefix.
 */
export function assertCatalogImage(tenantId: string, image: CatalogImageInput | null): void {
  if (image === null) return;
  if (
    image.bucket !== CATALOG_MEDIA_BUCKET ||
    !image.path.startsWith(`${tenantId}/catalog/`) ||
    image.path.includes("..")
  ) {
    throw new CatalogError("INVALID_INPUT");
  }
}

/** Row columns -> contract image (null when unset). */
export function imageFromColumns(
  bucket: string | null | undefined,
  path: string | null | undefined,
  alt: string | null | undefined,
): CatalogImage | null {
  return bucket && path ? { bucket, path, altText: alt ?? null } : null;
}
