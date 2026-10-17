import {
  RecordSupplierPaymentRequestSchema,
  SupplierPaymentSchema,
  SupplierPaymentsResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
import {
  SupplierPageQuerySchema,
  SupplierPathSchema,
} from "../../../../../../src/suppliers/request";

type RouteContext = { params: Promise<{ supplierId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SupplierPaymentsResponseSchema,
    handler: async (context) =>
      boundary.suppliersService.payments(
        context,
        parseRequest(SupplierPathSchema, await route.params).supplierId,
        parseRequest(
          SupplierPageQuerySchema,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
  });
}

export async function POST(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: RecordSupplierPaymentRequestSchema,
    responseSchema: SupplierPaymentSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.suppliersService.recordPayment(
        context,
        parseRequest(SupplierPathSchema, await route.params).supplierId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
