import { ProductDetailResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
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

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
