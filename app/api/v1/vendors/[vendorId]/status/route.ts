import { z } from "zod";

import {
  SetVendorStatusRequestSchema,
  VendorWriteResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const VendorPathSchema = z.object({ vendorId: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ vendorId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetVendorStatusRequestSchema,
    responseSchema: VendorWriteResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { vendorId } = parseRequest(VendorPathSchema, await params);
      return boundary.vendorService.setVendorStatus(context, vendorId, idempotencyKey, body.status);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
