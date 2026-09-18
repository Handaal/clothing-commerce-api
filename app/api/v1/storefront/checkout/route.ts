import {
  CheckoutRequestSchema,
  CheckoutResultSchema,
} from "../../../../../src/contracts/storefront/checkout";
import { createCheckoutService } from "../../../../../src/checkout/checkout-service";
import { readSupabasePrivilegedConfiguration } from "../../../../../src/config/auth-environment";
import { parseJsonBody, requireIdempotencyKey } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicRoute } from "../../../../../src/http/public-route";

export async function POST(request: Request) {
  return runPublicRoute({
    request,
    responseSchema: CheckoutResultSchema,
    handler: async () => {
      const key = requireIdempotencyKey(request);
      const intent = await parseJsonBody(request, CheckoutRequestSchema);
      const service = createCheckoutService(readSupabasePrivilegedConfiguration(process.env));
      return service.place(key, intent);
    },
  });
}
export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
