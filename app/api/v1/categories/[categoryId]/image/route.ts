import { z } from "zod";

import {
  SetCategoryImageResponseSchema,
  SetCatalogImageRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const PathSchema = z.object({ categoryId: z.string().uuid() });

// Set (or clear, with null) the category's website image. catalog.author tenant-wide; the image must come
// from the catalog-image upload intent.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetCatalogImageRequestSchema,
    responseSchema: SetCategoryImageResponseSchema,
    handler: async ({ context, body }) => {
      const { categoryId } = parseRequest(PathSchema, await params);
      return boundary.categoryService.setCategoryImage(context, categoryId, body.image);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
