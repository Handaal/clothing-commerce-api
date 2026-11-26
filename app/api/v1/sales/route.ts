import {
  CreateSaleRequestSchema,
  SaleListResponseSchema,
  SaleSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

// Catalog sales: per-unit online price reductions (percentage or fixed) on all items, a collection, or
// selected products. promotions.read to list; promotions.manage + Idempotency-Key to create.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SaleListResponseSchema,
    handler: (context) => boundary.merchandisingService.listSales(context),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateSaleRequestSchema,
    responseSchema: SaleSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.merchandisingService.createSale(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
