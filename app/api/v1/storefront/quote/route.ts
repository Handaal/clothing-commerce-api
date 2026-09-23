import {
  StorefrontQuoteRequestSchema,
  StorefrontQuoteResponseSchema,
} from "../../../../../src/contracts";
import { createCheckoutService } from "../../../../../src/checkout/checkout-service";
import { readSupabasePrivilegedConfiguration } from "../../../../../src/config/auth-environment";
import { parseJsonBody } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicRoute } from "../../../../../src/http/public-route";

export async function POST(request: Request) {
  return runPublicRoute({
    request,
    responseSchema: StorefrontQuoteResponseSchema,
    handler: async () => {
      const intent = await parseJsonBody(request, StorefrontQuoteRequestSchema);
      const service = createCheckoutService(readSupabasePrivilegedConfiguration(process.env));
      return service.quote(intent);
    },
  });
}
export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
