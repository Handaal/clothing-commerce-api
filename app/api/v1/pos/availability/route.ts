import { z } from "zod";
import { PosAvailabilityResponseSchema } from "../../../../../src/contracts/pos";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PosAvailabilityResponseSchema,
    handler: (context) => {
      const registerId = parseRequest(
        z.uuid(),
        new URL(request.url).searchParams.get("registerId"),
      );
      return boundary.posSaleService.getAvailability(context, registerId);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
