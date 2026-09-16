import {
  ArchiveProductMediaResponseSchema,
  PublishProductRequestSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { MediaPathSchema } from "../../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

// Archives a product media reference (soft; never a hard delete). Authorized via the media's owning
// brand. Reuses the empty-body request schema.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ productId: string; mediaId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: PublishProductRequestSchema,
    responseSchema: ArchiveProductMediaResponseSchema,
    handler: async ({ context, idempotencyKey }) => {
      const { mediaId } = parseRequest(MediaPathSchema, await params);
      return boundary.catalogManagementService.archiveMedia(context, mediaId, idempotencyKey);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
