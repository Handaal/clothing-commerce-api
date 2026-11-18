import { z } from "zod";

import { InventoryChannelStateResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const QuerySchema = z.object({ inventoryLocationId: z.string().uuid() }).strict();

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: InventoryChannelStateResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        QuerySchema,
        queryRecord(url.searchParams, ["inventoryLocationId"]),
      );
      return boundary.inventoryChannelService.getChannelState(context, query);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
