import {
  AdjustInventoryRequestSchema,
  AdjustInventoryResponseSchema,
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
    requestSchema: AdjustInventoryRequestSchema,
    responseSchema: AdjustInventoryResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const result = await boundary.inventoryService.adjustInventory(context, {
        variantId: body.variantId,
        inventoryLocationId: body.inventoryLocationId,
        countedQuantity: body.countedQuantity,
        expectedVersion: body.expectedVersion,
        idempotencyKey,
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      return {
        operationId: result.operationId,
        changed: result.changed,
        variantId: result.variantId,
        inventoryLocationId: result.inventoryLocationId,
        previousOnHand: result.previousOnHand,
        newOnHand: result.newOnHand,
        version: result.version,
      };
    },
  });
}

export function OPTIONS() {
  return managementOptionsResponse();
}
