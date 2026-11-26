import {
  SetProductVendorRequestSchema,
  SetProductVendorResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { ProductPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// Set or clear (vendorId: null) the label the product is made by.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetProductVendorRequestSchema,
    responseSchema: SetProductVendorResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { productId } = parseRequest(ProductPathSchema, await params);
      return boundary.vendorService.setProductVendor(
        context,
        productId,
        idempotencyKey,
        body.vendorId,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
