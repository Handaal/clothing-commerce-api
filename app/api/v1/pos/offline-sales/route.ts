import {
  IngestOfflineSaleRequestSchema,
  IngestOfflineSaleResponseSchema,
} from "../../../../../src/contracts";
import {
  RequestValidationError,
  managementOptionsResponse,
  runTenantDeviceWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantDeviceWriteRoute({
    request,
    requestSchema: IngestOfflineSaleRequestSchema,
    responseSchema: IngestOfflineSaleResponseSchema,
    handler: ({ tenantId, body, idempotencyKey }) => {
      if (idempotencyKey.toLowerCase() !== body.command.syncCommandId.toLowerCase()) {
        throw new RequestValidationError([
          { path: ["Idempotency-Key"], message: "Must equal command.syncCommandId." },
        ]);
      }
      return boundary.offlinePosService.ingest(tenantId, body);
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
