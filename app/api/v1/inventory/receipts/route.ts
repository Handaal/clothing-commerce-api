import {
  ReceiveInventoryRequestSchema,
  ReceiveInventoryResponseSchema,
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
    requestSchema: ReceiveInventoryRequestSchema,
    responseSchema: ReceiveInventoryResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const result = await boundary.inventoryService.receiveInventory(context, {
        variantId: body.variantId,
        inventoryLocationId: body.inventoryLocationId,
        quantity: body.quantity,
        idempotencyKey,
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      return {
        operationId: result.operationId,
        variantId: result.variantId,
        inventoryLocationId: result.inventoryLocationId,
        observedOnHand: result.observedOnHand,
        observedVersion: result.observedVersion,
      };
    },
  });
}

export function OPTIONS() {
  return managementOptionsResponse();
}
