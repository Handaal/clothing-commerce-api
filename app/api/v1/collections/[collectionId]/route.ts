import { z } from "zod";

import {
  CollectionDetailResponseSchema,
  CollectionUpdatedResponseSchema,
  UpdateCollectionRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const CollectionPathSchema = z.object({ collectionId: z.string().uuid() });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ collectionId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CollectionDetailResponseSchema,
    handler: async (context) => {
      const { collectionId } = parseRequest(CollectionPathSchema, await params);
      return boundary.collectionManagementService.getCollection(context, collectionId);
    },
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ collectionId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateCollectionRequestSchema,
    responseSchema: CollectionUpdatedResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { collectionId } = parseRequest(CollectionPathSchema, await params);
      return boundary.collectionManagementService.updateCollection(
        context,
        collectionId,
        idempotencyKey,
        {
          name: body.name,
          slug: body.slug,
          ...(body.description !== undefined ? { description: body.description } : {}),
        },
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
