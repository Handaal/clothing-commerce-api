import {
  ReorderProductMediaRequestSchema,
  ReorderProductMediaResponseSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

// SDK 0.53: the complete photo order (every active photo once); the first becomes the main photo.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: ReorderProductMediaRequestSchema,
    responseSchema: ReorderProductMediaResponseSchema,
    handler: async ({ context, body }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.reorderMedia(context, productId, body.mediaIds);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
