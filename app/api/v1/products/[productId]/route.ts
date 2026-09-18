import {
  ProductDetailResponseSchema,
  ProductUpdatedResponseSchema,
  UpdateProductRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ProductDetailResponseSchema,
    handler: async (context) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogReadService.getProduct(context, productId);
    },
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateProductRequestSchema,
    responseSchema: ProductUpdatedResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.updateProduct(context, productId, idempotencyKey, {
        name: body.name,
        slug: body.slug,
        ...(body.styleCode !== undefined ? { styleCode: body.styleCode } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
