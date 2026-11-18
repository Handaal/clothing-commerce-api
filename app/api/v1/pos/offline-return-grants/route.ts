import {
  IssueOfflineReturnGrantRequestSchema,
  OfflineReturnGrantResponseSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: IssueOfflineReturnGrantRequestSchema,
    responseSchema: OfflineReturnGrantResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.offlinePosService.issueReturnGrant(
        context,
        body.deviceId,
        body.registerId,
        body.orderId,
        idempotencyKey,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
