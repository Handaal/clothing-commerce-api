import { z } from "zod";
import {
  DeleteSupplierReminderResponseSchema,
  SupplierReminderSchema,
  UpdateSupplierReminderRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
import { SupplierReminderPathSchema } from "../../../../../../src/suppliers/request";

type RouteContext = { params: Promise<{ reminderId: string }> };

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateSupplierReminderRequestSchema,
    responseSchema: SupplierReminderSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.suppliersService.updateReminder(
        context,
        parseRequest(SupplierReminderPathSchema, await route.params).reminderId,
        idempotencyKey,
        body,
      ),
  });
}

export async function DELETE(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: z.object({}).strict(),
    responseSchema: DeleteSupplierReminderResponseSchema,
    handler: async ({ context, idempotencyKey }) =>
      boundary.suppliersService.deleteReminder(
        context,
        parseRequest(SupplierReminderPathSchema, await route.params).reminderId,
        idempotencyKey,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
