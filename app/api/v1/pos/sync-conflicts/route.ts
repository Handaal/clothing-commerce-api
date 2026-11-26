import {
  ListPosSyncConflictsQuerySchema,
  ListPosSyncConflictsResponseSchema,
} from "../../../../../src/contracts/pos";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// ADR-042 §13.5 — read-only post-sync conflict report for the POS Sync Conflicts section and admin-mobile.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ListPosSyncConflictsResponseSchema,
    handler: (context) => {
      const params = new URL(request.url).searchParams;
      const query = parseRequest(ListPosSyncConflictsQuerySchema, {
        registerId: params.get("registerId") ?? undefined,
        kind: params.get("kind") ?? undefined,
        status: params.get("status") ?? undefined,
        limit: params.get("limit") ?? undefined,
      });
      return boundary.offlinePosService.listSyncConflicts(context, query);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
