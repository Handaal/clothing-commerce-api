import { z } from "zod";
import {
  ReturnHistoryResponseSchema,
  ReturnDetailResponseSchema as DetailSchema,
  CreateReturnRequestSchema,
} from "../../../../../../src/contracts/management/returns";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
const PathSchema = z.object({ orderId: z.uuid() });
export async function GET(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ReturnHistoryResponseSchema,
    handler: async (context) => {
      const { orderId } = parseRequest(PathSchema, await params);
      const query = parseRequest(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.uuid().optional(),
        }),
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return boundary.returnsService.history(context, orderId, query.limit, query.cursor);
    },
  });
}
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateReturnRequestSchema,
    responseSchema: DetailSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { orderId } = parseRequest(PathSchema, await params);
      const client = request.headers.get("X-Client-Type");
      const source =
        client === "admin-mobile"
          ? "admin-mobile"
          : client === "pos-desktop"
            ? "pos"
            : "management";
      return boundary.returnsService.create(context, orderId, idempotencyKey, body, source);
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
