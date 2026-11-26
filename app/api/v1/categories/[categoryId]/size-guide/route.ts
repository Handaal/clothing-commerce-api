import { z } from "zod";

import {
  SetCategorySizeGuideRequestSchema,
  SetCategorySizeGuideResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const CategoryPathSchema = z.object({ categoryId: z.string().uuid() });

// Replace (or clear, with null) the size chart shown for products in this category and its descendants.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetCategorySizeGuideRequestSchema,
    responseSchema: SetCategorySizeGuideResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { categoryId } = parseRequest(CategoryPathSchema, await params);
      return boundary.categoryService.setCategorySizeGuide(
        context,
        categoryId,
        idempotencyKey,
        body.sizeGuide,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
