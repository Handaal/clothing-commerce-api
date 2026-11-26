import { z } from "zod";

import {
  UpdateVendorRequestSchema,
  VendorUpdatedResponseSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const VendorPathSchema = z.object({ vendorId: z.string().uuid() });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ vendorId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateVendorRequestSchema,
    responseSchema: VendorUpdatedResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { vendorId } = parseRequest(VendorPathSchema, await params);
      return boundary.vendorService.updateVendor(context, vendorId, idempotencyKey, {
        name: body.name,
        slug: body.slug,
        ...(body.position !== undefined ? { position: body.position } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
