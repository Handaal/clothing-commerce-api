import {
  CreateProductRequestSchema,
  ProductListResponseSchema,
  ProductWriteResponseSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
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

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateProductRequestSchema,
    responseSchema: ProductWriteResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.catalogManagementService.createProduct(context, idempotencyKey, {
        brandId: body.brandId,
        name: body.name,
        slug: body.slug,
        ...(body.styleCode !== undefined ? { styleCode: body.styleCode } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      }),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
