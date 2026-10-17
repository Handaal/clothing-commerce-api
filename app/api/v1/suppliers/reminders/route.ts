import {
  CreateSupplierReminderRequestSchema,
  SupplierReminderSchema,
  SupplierRemindersResponseSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";
import { SupplierReminderListQuerySchema } from "../../../../../src/suppliers/request";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SupplierRemindersResponseSchema,
    handler: (context) =>
      boundary.suppliersService.reminders(
        context,
        parseRequest(
          SupplierReminderListQuerySchema,
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
    requestSchema: CreateSupplierReminderRequestSchema,
    responseSchema: SupplierReminderSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.suppliersService.createReminder(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
