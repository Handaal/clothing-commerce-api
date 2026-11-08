import {
  CreatePosLoginRequestSchema,
  PosLoginListResponseSchema,
  StaffDetailSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

/** List every pos_pin account in the tenant for the admin "Team" surface. Requires tenant-wide staff.manage. */
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PosLoginListResponseSchema,
    handler: (context) => boundary.posAuthService.listLogins(context),
  });
}

/**
 * Provision a pos_pin login (server-minted subject + online PIN verifier + membership + initial role/scope
 * + POS UI access) in one idempotent step. Requires tenant-wide staff.manage. The RBAC role/scope still
 * govern API access; posRole/posPermissions only shape the POS sidebar.
 */
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreatePosLoginRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.posAuthService.createLogin(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
