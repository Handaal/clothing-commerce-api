import { z } from "zod";

import {
  SetVariantOptionsRequestSchema,
  SetVariantOptionsResponseSchema,
} from "../../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../../../src/management/server-management-boundary";

const VariantOptionsPathSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
});

// Replace the variant's option values (e.g. Size M, Colour Black).
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ productId: string; variantId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetVariantOptionsRequestSchema,
    responseSchema: SetVariantOptionsResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { productId, variantId } = parseRequest(VariantOptionsPathSchema, await params);
      return boundary.catalogManagementService.setVariantOptions(
        context,
        productId,
        variantId,
        idempotencyKey,
        body.options,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
