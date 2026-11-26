import {
  SetProductCategoriesRequestSchema,
  SetProductCategoriesResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// Replace the product's full category membership.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetProductCategoriesRequestSchema,
    responseSchema: SetProductCategoriesResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.categoryService.setProductCategories(
        context,
        productId,
        idempotencyKey,
        body.categoryIds,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
