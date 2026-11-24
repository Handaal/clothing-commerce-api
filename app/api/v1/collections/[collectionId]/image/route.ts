import { z } from "zod";

import {
  SetCollectionImageResponseSchema,
  SetCatalogImageRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const PathSchema = z.object({ collectionId: z.string().uuid() });

// Set (or clear, with null) the collection's website image. catalog.author tenant-wide; the image must come
// from the catalog-image upload intent.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ collectionId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetCatalogImageRequestSchema,
    responseSchema: SetCollectionImageResponseSchema,
    handler: async ({ context, body }) => {
      const { collectionId } = parseRequest(PathSchema, await params);
      return boundary.collectionManagementService.setCollectionImage(
        context,
        collectionId,
        body.image,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
