import {
  UpdateOptionValuesRequestSchema,
  UpdateOptionValuesResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// Set swatch colours / display order of the product's option values.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateOptionValuesRequestSchema,
    responseSchema: UpdateOptionValuesResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.updateOptionValues(
        context,
        productId,
        idempotencyKey,
        body.values,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
