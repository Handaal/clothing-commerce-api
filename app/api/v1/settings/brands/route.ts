import {
  BrandSchema,
  BrandListResponseSchema,
  CreateBrandRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { BrandListQuerySchema } from "../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: BrandListResponseSchema,
    handler: (context) =>
      boundary.settingsService.listBrands(
        context,
        parseRequest(BrandListQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateBrandRequestSchema,
    responseSchema: BrandSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.settingsService.createBrand(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
