import {
  CreateVariantRequestSchema,
  CreateVariantResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateVariantRequestSchema,
    responseSchema: CreateVariantResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.createVariant(context, productId, idempotencyKey, {
        sku: body.sku,
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
