import {
  TransferInventoryRequestSchema,
  TransferInventoryResponseSchema,
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
    requestSchema: TransferInventoryRequestSchema,
    responseSchema: TransferInventoryResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const result = await boundary.inventoryService.transferInventory(context, {
        variantId: body.variantId,
        sourceInventoryLocationId: body.sourceInventoryLocationId,
        destinationInventoryLocationId: body.destinationInventoryLocationId,
        quantity: body.quantity,
        idempotencyKey,
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      return {
        operationId: result.operationId,
        variantId: result.variantId,
        source: {
          inventoryLocationId: result.source.inventoryLocationId,
          observedOnHand: result.source.observedOnHand,
          observedVersion: result.source.observedVersion,
        },
        destination: {
          inventoryLocationId: result.destination.inventoryLocationId,
          observedOnHand: result.destination.observedOnHand,
          observedVersion: result.destination.observedVersion,
        },
      };
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
