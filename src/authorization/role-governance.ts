import { AuthorizationError } from "./errors";

export type ProtectedRoleMutation = "rename" | "archive" | "delete" | "change_permissions";

/**
 * Protected roles are platform-governed. This guard is additional to the caller's required
 * staff-management permission check; it never grants a mutation by itself.
 */
export function assertRoleMutationAllowed(input: {
  readonly isProtectedRole: boolean;
  readonly mutation: ProtectedRoleMutation;
}): void {
  if (input.isProtectedRole) {
    throw new AuthorizationError("PROTECTED_ROLE_MUTATION_DENIED");
  }
}
