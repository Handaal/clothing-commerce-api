import { z } from "zod";

import {
  CategoryWriteResponseSchema,
  SetCategoryStatusRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const CategoryPathSchema = z.object({ categoryId: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ categoryId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetCategoryStatusRequestSchema,
    responseSchema: CategoryWriteResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { categoryId } = parseRequest(CategoryPathSchema, await params);
      return boundary.categoryService.setCategoryStatus(context, categoryId, idempotencyKey, {
        status: body.status,
        ...(body.archiveReason !== undefined ? { archiveReason: body.archiveReason } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
