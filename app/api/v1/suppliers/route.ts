import {
  CreateSupplierRequestSchema,
  SupplierSchema,
  SupplierListResponseSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../src/http/management-route";
import { SupplierListQuerySchema } from "../../../../src/suppliers/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SupplierListResponseSchema,
    handler: (context) =>
      boundary.suppliersService.list(
        context,
        parseRequest(
          SupplierListQuerySchema,
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
    requestSchema: CreateSupplierRequestSchema,
    responseSchema: SupplierSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.suppliersService.create(context, idempotencyKey, body),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
