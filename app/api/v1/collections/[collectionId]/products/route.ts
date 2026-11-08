import { z } from "zod";

import {
  SetCollectionProductsRequestSchema,
  SetCollectionProductsResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const CollectionPathSchema = z.object({ collectionId: z.string().uuid() });

// PUT replaces the full ordered membership of the collection in one atomic command.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ collectionId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetCollectionProductsRequestSchema,
    responseSchema: SetCollectionProductsResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { collectionId } = parseRequest(CollectionPathSchema, await params);
      return boundary.collectionManagementService.setCollectionProducts(
        context,
        collectionId,
        idempotencyKey,
        body.productIds,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
