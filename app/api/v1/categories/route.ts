import {
  CategoryListResponseSchema,
  CategoryWriteResponseSchema,
  CreateCategoryRequestSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CategoryListResponseSchema,
    handler: (context) => boundary.categoryService.listCategories(context),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateCategoryRequestSchema,
    responseSchema: CategoryWriteResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.categoryService.createCategory(context, idempotencyKey, {
        parentId: body.parentId ?? null,
        name: body.name,
        slug: body.slug,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
      }),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
