import {
  InitializeInventoryChannelsRequestSchema,
  InitializeInventoryChannelsResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: InitializeInventoryChannelsRequestSchema,
    responseSchema: InitializeInventoryChannelsResponseSchema,
    handler: ({ context, body }) =>
      boundary.inventoryChannelService.initializeChannels(context, {
        inventoryLocationId: body.inventoryLocationId,
      }),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
