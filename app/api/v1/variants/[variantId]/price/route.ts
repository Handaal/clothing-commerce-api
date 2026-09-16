import {
  SetVariantPriceRequestSchema,
  SetVariantPriceResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { VariantPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// PUT sets the variant's active base price for a currency (archiving the prior active row). Authorized
// via the variant's owning brand.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ variantId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetVariantPriceRequestSchema,
    responseSchema: SetVariantPriceResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { variantId } = parseRequest(VariantPathSchema, await params);
      return boundary.catalogManagementService.setVariantPrice(context, variantId, idempotencyKey, {
        currency: body.currency,
        amountMinor: body.amountMinor,
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
