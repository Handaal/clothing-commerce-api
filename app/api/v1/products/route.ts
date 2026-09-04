import { ProductListResponseSchema } from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../src/http/management-route";
import { ProductListQuerySchema, queryRecord } from "../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ProductListResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        ProductListQuerySchema,
        queryRecord(url.searchParams, ["brandId", "status", "limit", "cursor"]),
      );
      return boundary.catalogReadService.listProducts(context, {
        ...(query.brandId !== undefined ? { brandId: query.brandId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
