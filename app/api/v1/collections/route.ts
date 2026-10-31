import {
  CollectionListResponseSchema,
  CollectionWriteResponseSchema,
  CreateCollectionRequestSchema,
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
    responseSchema: CollectionListResponseSchema,
    handler: (context) => boundary.collectionManagementService.listCollections(context),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateCollectionRequestSchema,
    responseSchema: CollectionWriteResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.collectionManagementService.createCollection(context, idempotencyKey, {
        name: body.name,
        slug: body.slug,
        ...(body.description !== undefined ? { description: body.description } : {}),
      }),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
