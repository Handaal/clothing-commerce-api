import { InventoryListResponseSchema } from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../src/http/management-route";
import { InventoryListQuerySchema, queryRecord } from "../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: InventoryListResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        InventoryListQuerySchema,
        queryRecord(url.searchParams, ["inventoryLocationId", "variantId", "limit", "cursor"]),
      );
      return boundary.inventoryReadService.listBalances(context, {
        ...(query.inventoryLocationId !== undefined
          ? { inventoryLocationId: query.inventoryLocationId }
          : {}),
        ...(query.variantId !== undefined ? { variantId: query.variantId } : {}),
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
    },
  });
}

export function OPTIONS() {
  return managementOptionsResponse();
}
