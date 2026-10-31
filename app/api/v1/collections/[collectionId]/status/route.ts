import { z } from "zod";

import {
  CollectionWriteResponseSchema,
  SetCollectionStatusRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const CollectionPathSchema = z.object({ collectionId: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ collectionId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetCollectionStatusRequestSchema,
    responseSchema: CollectionWriteResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { collectionId } = parseRequest(CollectionPathSchema, await params);
      return boundary.collectionManagementService.setCollectionStatus(
        context,
        collectionId,
        idempotencyKey,
        {
          status: body.status,
          ...(body.archiveReason !== undefined ? { archiveReason: body.archiveReason } : {}),
        },
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
