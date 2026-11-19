import { z } from "zod";

import { PublicDeliveryOptionsSchema } from "../../../../../src/contracts";
import { createCheckoutService } from "../../../../../src/checkout/checkout-service";
import { readSupabasePrivilegedConfiguration } from "../../../../../src/config/auth-environment";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { queryRecord } from "../../../../../src/management/request";

const DeliveryQuerySchema = z.object({ tenantId: z.uuid(), brandId: z.uuid() });

// PUBLIC: the brand's active delivery areas, fees and free-delivery threshold for the Storefront.
export async function GET(request: Request) {
  return runPublicReadRoute({
    request,
    responseSchema: PublicDeliveryOptionsSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        DeliveryQuerySchema,
        queryRecord(url.searchParams, ["tenantId", "brandId"]),
      );
      const service = createCheckoutService(readSupabasePrivilegedConfiguration(process.env));
      return service.deliveryOptions(query.tenantId, query.brandId);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
