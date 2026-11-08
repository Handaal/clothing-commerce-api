import {
  SetVariantCostRequestSchema,
  SetVariantCostResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { VariantPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// PUT sets the variant's current cost basis (minor units) used for inventory valuation. Authorized
// via the variant's owning brand, mirroring the price write.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ variantId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetVariantCostRequestSchema,
    responseSchema: SetVariantCostResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { variantId } = parseRequest(VariantPathSchema, await params);
      return boundary.catalogManagementService.setVariantCost(context, variantId, idempotencyKey, {
        unitCostMinor: body.unitCostMinor,
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
