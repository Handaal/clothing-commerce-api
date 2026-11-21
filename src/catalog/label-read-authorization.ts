import {
  AuthorizationError,
  type AuthorizationContext,
  type AuthorizationService,
  type AuthorizedOperationContext,
} from "../authorization";
import { ManagementReadPermission, deriveCatalogReadVisibility } from "../management/visibility";

/**
 * Who may READ the tenant's catalogue labels (category tree, vendor/"Brand" list). These names are
 * already public on the Storefront, and every selling channel needs them to group and search products:
 * a POS cashier with only `catalog.read` (brand-scoped) must see "T-Shirts" and "Zara", not
 * "Uncategorized". So a list read passes with `catalog.author` (tenant-wide, as before) OR with
 * `catalog.read` over any brand the member can read. Writes keep requiring `catalog.author`.
 */
export async function authorizeCatalogLabelRead(
  authorization: AuthorizationService,
  context: AuthorizationContext,
  authorPermission: string,
): Promise<AuthorizedOperationContext> {
  try {
    return await authorization.authorize(context, { permissionKey: authorPermission });
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    const visibility = deriveCatalogReadVisibility(context);
    if (!visibility.canRead) throw error;
    const brandId = visibility.brandIds[0];
    return authorization.authorize(context, {
      permissionKey: ManagementReadPermission.catalog,
      ...(visibility.tenantWide || brandId === undefined
        ? {}
        : { resources: [{ kind: "brand", id: brandId }] }),
    });
  }
}
