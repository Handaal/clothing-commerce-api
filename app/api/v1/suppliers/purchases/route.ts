import {
  RecordSupplierPurchaseRequestSchema,
  SupplierPurchaseSchema,
  SupplierPurchasesResponseSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";
import { SupplierPurchaseListQuerySchema } from "../../../../../src/suppliers/request";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SupplierPurchasesResponseSchema,
    handler: (context) =>
      boundary.suppliersService.purchases(
        context,
        parseRequest(
          SupplierPurchaseListQuerySchema,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: RecordSupplierPurchaseRequestSchema,
    responseSchema: SupplierPurchaseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.suppliersService.recordPurchase(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
