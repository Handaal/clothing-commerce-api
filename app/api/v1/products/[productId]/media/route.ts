import {
  RegisterProductMediaRequestSchema,
  RegisterProductMediaResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// Registers/finalizes a product media reference (object-storage pointer) after the client uploads the
// object to the server-authorized bucket/path from the upload intent.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: RegisterProductMediaRequestSchema,
    responseSchema: RegisterProductMediaResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.catalogManagementService.registerMedia(context, productId, idempotencyKey, {
        ...(body.variantId !== undefined ? { variantId: body.variantId } : {}),
        bucket: body.bucket,
        path: body.path,
        ...(body.altText !== undefined ? { altText: body.altText } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
