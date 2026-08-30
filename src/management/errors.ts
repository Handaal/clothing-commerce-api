/**
 * Errors specific to the management read boundary. Authorization/permission/scope denials reuse the
 * existing AuthorizationError (401/403); cursor problems use InvalidCursorError (400). This module adds
 * the safe not-found signal used for tenant-contained containment lookups and missing resources.
 */

export class ManagementNotFoundError extends Error {
  readonly code = "RESOURCE_NOT_FOUND";
  readonly httpStatus = 404 as const;

  constructor(message = "The requested resource was not found.") {
    super(message);
    this.name = "ManagementNotFoundError";
  }
}
