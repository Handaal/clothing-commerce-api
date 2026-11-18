import {
  IngestOfflineCustomerRequestSchema,
  IngestOfflineCustomerResponseSchema,
} from "../../../../../src/contracts";
import {
  RequestValidationError,
  managementOptionsResponse,
  runTenantDeviceWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

/** ADR-042 §8: device-signed new customer captured offline. Duplicates are flagged, never merged. */
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantDeviceWriteRoute({
    request,
    requestSchema: IngestOfflineCustomerRequestSchema,
    responseSchema: IngestOfflineCustomerResponseSchema,
    handler: ({ tenantId, body, idempotencyKey }) => {
      if (idempotencyKey.toLowerCase() !== body.command.syncCommandId.toLowerCase()) {
        throw new RequestValidationError([
          { path: ["Idempotency-Key"], message: "Must equal command.syncCommandId." },
        ]);
      }
      return boundary.offlinePosService.ingestCustomer(tenantId, body);
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
