import {
  PublishProductRequestSchema,
  PublishProductResponseSchema,
  UnpublishProductResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// POST publishes; DELETE unpublishes. Both require the distinct catalog.publish permission.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: PublishProductRequestSchema,
    responseSchema: PublishProductResponseSchema,
    handler: async ({ context, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.publishProduct(context, productId, idempotencyKey);
    },
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: PublishProductRequestSchema,
    responseSchema: UnpublishProductResponseSchema,
    handler: async ({ context, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.unpublishProduct(context, productId, idempotencyKey);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
