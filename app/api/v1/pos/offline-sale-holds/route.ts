import {
  IngestOfflineSaleHoldRequestSchema,
  IngestOfflineSaleHoldResponseSchema,
} from "../../../../../src/contracts";
import {
  RequestValidationError,
  managementOptionsResponse,
  runTenantDeviceWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

/**
 * ADR-042 §4.6 (Finding A): device-signed terminal hold for an offline sale whose offline-created customer
 * was rejected. The ordinal becomes held_for_reconciliation (sale not applied, units stay reserved) so the
 * stock grant can close. No approval step; exact replay returns the original receipt.
 */
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantDeviceWriteRoute({
    request,
    requestSchema: IngestOfflineSaleHoldRequestSchema,
    responseSchema: IngestOfflineSaleHoldResponseSchema,
    handler: ({ tenantId, body, idempotencyKey }) => {
      if (idempotencyKey.toLowerCase() !== body.command.syncCommandId.toLowerCase()) {
        throw new RequestValidationError([
          { path: ["Idempotency-Key"], message: "Must equal command.syncCommandId." },
        ]);
      }
      return boundary.offlinePosService.ingestSaleHold(tenantId, body);
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
