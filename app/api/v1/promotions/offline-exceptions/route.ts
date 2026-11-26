import { OfflineVoucherExceptionListResponseSchema } from "../../../../../src/contracts/management/promotions";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";
import { PromotionListQuerySchema } from "../../../../../src/promotions/request";

/** ADR-042 D-2: offline voucher discounts honoured at the till without a valid reservation (report only). */
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: OfflineVoucherExceptionListResponseSchema,
    handler: (context) =>
      boundary.promotionsService.offlineVoucherExceptions(
        context,
        parseRequest(
          PromotionListQuerySchema,
          Object.fromEntries(new URL(request.url).searchParams.entries()),
        ),
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
