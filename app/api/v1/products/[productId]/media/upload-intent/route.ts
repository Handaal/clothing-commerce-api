import {
  CreateMediaUploadIntentRequestSchema,
  MediaUploadIntentResponseSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementBodyRoute,
} from "../../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

// Authorizes the upload and returns a server-controlled, tenant/product-scoped destination (and a
// signed upload URL when object storage is reachable). The client can never choose the destination.
// This is not a durable mutation, so it requires no Idempotency-Key.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateMediaUploadIntentRequestSchema,
    responseSchema: MediaUploadIntentResponseSchema,
    handler: async ({ context, body }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.createMediaUploadIntent(context, productId, {
        ...(body.variantId !== undefined ? { variantId: body.variantId } : {}),
        contentType: body.contentType,
        ...(body.fileName !== undefined ? { fileName: body.fileName } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
