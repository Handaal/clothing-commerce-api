import { z } from "zod";

import {
  CategoryUpdatedResponseSchema,
  UpdateCategoryRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const CategoryPathSchema = z.object({ categoryId: z.string().uuid() });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateCategoryRequestSchema,
    responseSchema: CategoryUpdatedResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { categoryId } = parseRequest(CategoryPathSchema, await params);
      return boundary.categoryService.updateCategory(context, categoryId, idempotencyKey, {
        parentId: body.parentId,
        name: body.name,
        slug: body.slug,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
