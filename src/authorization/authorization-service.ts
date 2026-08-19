import { AuthorizationError } from "./errors";
import {
  AuthorizationResourceSchema,
  PermissionKeySchema,
  type AuthorizationContext,
  type AuthorizationRequest,
  type AuthorizationResource,
  type EffectiveAuthorizationAssignment,
} from "./model";
import type { AuthorizationStateRepository } from "./repository";

declare const authorizedOperationTypeBrand: unique symbol;
const issuedAuthorizationProofs = new WeakSet<object>();

function freezeResource(resource: AuthorizationResource): AuthorizationResource {
  return Object.freeze({ ...resource });
}

function freezeAuthorizationContext(context: AuthorizationContext): AuthorizationContext {
  return Object.freeze({
    authentication: Object.freeze({ ...context.authentication }),
    userIdentity: Object.freeze({ ...context.userIdentity }),
    tenant: Object.freeze({ ...context.tenant }),
    membership: Object.freeze({ ...context.membership }),
    assignments: Object.freeze(
      context.assignments.map((assignment) =>
        Object.freeze({
          ...assignment,
          scopeTargets: Object.freeze(assignment.scopeTargets.map(freezeResource)),
          permissionKeys: Object.freeze([...assignment.permissionKeys]),
        }),
      ),
    ),
    ...(context.device ? { device: Object.freeze({ ...context.device }) } : {}),
  });
}

/** Opaque proof that permission, scope, and resource ownership checks succeeded. */
export interface AuthorizedOperationContext {
  readonly [authorizedOperationTypeBrand]: true;
  readonly authorization: AuthorizationContext;
  readonly permissionKey: string;
  readonly resources: readonly AuthorizationResource[];
  readonly grantingAssignmentIds: readonly string[];
}

export class AuthorizationService {
  constructor(private readonly repository: AuthorizationStateRepository) {}

  async authorize(
    context: AuthorizationContext,
    request: AuthorizationRequest,
  ): Promise<AuthorizedOperationContext> {
    const permission = PermissionKeySchema.safeParse(request.permissionKey);
    if (!permission.success) {
      throw new AuthorizationError("PERMISSION_DENIED");
    }

    const grantingAssignments = context.assignments.filter((assignment) =>
      assignment.permissionKeys.includes(permission.data),
    );
    if (grantingAssignments.length === 0) {
      throw new AuthorizationError("PERMISSION_DENIED");
    }

    const resourcesByKey = new Map<string, AuthorizationResource>();
    for (const resource of request.resources ?? []) {
      const parsed = AuthorizationResourceSchema.safeParse(resource);
      if (!parsed.success) {
        throw new AuthorizationError("SCOPE_DENIED");
      }
      resourcesByKey.set(`${parsed.data.kind}:${parsed.data.id}`, parsed.data);
    }
    const resources = [...resourcesByKey.values()];

    const grantingAssignmentIds = new Set<string>();
    if (resources.length === 0) {
      const tenantWideAssignment = grantingAssignments.find(
        (assignment) => assignment.scopeMode === "tenant",
      );
      if (!tenantWideAssignment) {
        throw new AuthorizationError("SCOPE_DENIED");
      }
      grantingAssignmentIds.add(tenantWideAssignment.assignmentId);
    }

    for (const resource of resources) {
      const tenantIds = await this.repository.findResourceTenantIds(resource);
      if (tenantIds.length !== 1 || tenantIds[0] !== context.tenant.id) {
        throw new AuthorizationError("TENANT_ACCESS_DENIED");
      }

      const coveringAssignment = grantingAssignments.find((assignment) =>
        this.assignmentCovers(assignment, resource),
      );
      if (!coveringAssignment) {
        throw new AuthorizationError("SCOPE_DENIED");
      }
      grantingAssignmentIds.add(coveringAssignment.assignmentId);
    }

    const proof = Object.freeze({
      authorization: freezeAuthorizationContext(context),
      permissionKey: permission.data,
      resources: Object.freeze(resources.map(freezeResource)),
      grantingAssignmentIds: Object.freeze([...grantingAssignmentIds]),
    }) as unknown as AuthorizedOperationContext;
    issuedAuthorizationProofs.add(proof);
    return proof;
  }

  private assignmentCovers(
    assignment: EffectiveAuthorizationAssignment,
    resource: AuthorizationResource,
  ): boolean {
    if (assignment.scopeMode === "tenant") {
      return true;
    }

    return assignment.scopeTargets.some(
      (target) => target.kind === resource.kind && target.id === resource.id,
    );
  }
}

/**
 * Rejects structurally similar objects that were not issued by this process's authorization
 * service. Privileged repositories should call this before using a proof.
 */
export function assertAuthorizedOperationProof(
  value: unknown,
): asserts value is AuthorizedOperationContext {
  if (typeof value !== "object" || value === null || !issuedAuthorizationProofs.has(value)) {
    throw new AuthorizationError("AUTHORIZATION_PROOF_INVALID");
  }
}

export async function executeAuthorizedOperation<T>(options: {
  readonly authorizationService: AuthorizationService;
  readonly context: AuthorizationContext;
  readonly request: AuthorizationRequest;
  readonly operation: (proof: AuthorizedOperationContext) => Promise<T>;
}): Promise<T> {
  const proof = await options.authorizationService.authorize(options.context, options.request);
  assertAuthorizedOperationProof(proof);
  return options.operation(proof);
}
