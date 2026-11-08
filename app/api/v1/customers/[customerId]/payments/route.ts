import {
  RecordCustomerPaymentRequestSchema,
  RecordCustomerPaymentResponseSchema,
  CustomerPaymentsResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { CustomerPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ customerId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CustomerPaymentsResponseSchema,
    handler: async (context) =>
      boundary.customersArService.payments(
        context,
        parseRequest(CustomerPathSchema, await route.params).customerId,
      ),
  });
}

export async function POST(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: RecordCustomerPaymentRequestSchema,
    responseSchema: RecordCustomerPaymentResponseSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.customersArService.recordPayment(
        context,
        parseRequest(CustomerPathSchema, await route.params).customerId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
