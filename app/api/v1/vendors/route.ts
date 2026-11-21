import {
  CreateVendorRequestSchema,
  VendorListResponseSchema,
  VendorWriteResponseSchema,
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
    responseSchema: VendorListResponseSchema,
    handler: (context) => boundary.vendorService.listVendors(context),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateVendorRequestSchema,
    responseSchema: VendorWriteResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.vendorService.createVendor(context, idempotencyKey, {
        name: body.name,
        slug: body.slug,
        ...(body.position !== undefined ? { position: body.position } : {}),
      }),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
