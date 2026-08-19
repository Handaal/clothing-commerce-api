export { AuthorizationContextResolver } from "./context-resolver";
export {
  AuthorizationService,
  assertAuthorizedOperationProof,
  executeAuthorizedOperation,
  type AuthorizedOperationContext,
} from "./authorization-service";
export {
  AuthorizationError,
  authorizationErrorCodes,
  authorizationErrorResponse,
  type AuthorizationErrorCode,
} from "./errors";
export {
  AuthorizationResourceSchema,
  PermissionKeySchema,
  TenantSelectionSchema,
  type AuthorizationContext,
  type AuthorizationRequest,
  type AuthorizationResource,
  type VerifiedDeviceIdentity,
  type VerifiedExternalIdentity,
} from "./model";
export { assertRoleMutationAllowed, type ProtectedRoleMutation } from "./role-governance";
export type { AuthorizationStateRepository } from "./repository";
