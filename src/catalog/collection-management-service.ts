import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import type {
  CollectionDetailResponse,
  CollectionListResponse,
  CollectionStatus,
} from "../contracts/management/collections";
import type { CollectionRepository } from "./collection-repository";

/**
 * Collections are tenant-wide merchandising groupings (no brand scope), so this service authorizes the
 * existing catalog.author permission tenant-wide — the same shape the settings service uses — rather
 * than against a brand resource. Every read requires a catalog.author grant and every mutation the same;
 * reuse keeps the permission vocabulary small while still gating collection management behind catalog
 * authoring. Mutation safety (idempotency, slug conflicts, membership integrity) lives in the DB RPCs.
 */
export const CollectionPermission = { author: "catalog.author" } as const;

export interface CreateCollectionInput {
  name: string;
  slug: string;
  description?: string;
}
export interface UpdateCollectionInput {
  name: string;
  slug: string;
  description?: string;
}
export interface SetCollectionStatusInput {
  status: CollectionStatus;
  archiveReason?: string;
}

export class CollectionManagementService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: CollectionRepository,
  ) {}

  private authorize(context: AuthorizationContext) {
    return this.authorization.authorize(context, { permissionKey: CollectionPermission.author });
  }

  async listCollections(context: AuthorizationContext): Promise<CollectionListResponse> {
    const proof = await this.authorize(context);
    const collections = await this.repository.listCollections(proof, context.tenant.id);
    return { collections };
  }

  async getCollection(
    context: AuthorizationContext,
    collectionId: string,
  ): Promise<CollectionDetailResponse> {
    const proof = await this.authorize(context);
    return this.repository.getCollection(proof, context.tenant.id, collectionId);
  }

  async createCollection(
    context: AuthorizationContext,
    idempotencyKey: string,
    input: CreateCollectionInput,
  ) {
    const proof = await this.authorize(context);
    return this.repository.createCollection(proof, {
      tenantId: context.tenant.id,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      actorMembershipId: context.membership.id,
      idempotencyKey,
    });
  }

  async updateCollection(
    context: AuthorizationContext,
    collectionId: string,
    idempotencyKey: string,
    input: UpdateCollectionInput,
  ) {
    const proof = await this.authorize(context);
    return this.repository.updateCollection(proof, {
      tenantId: context.tenant.id,
      collectionId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      idempotencyKey,
    });
  }

  async setCollectionStatus(
    context: AuthorizationContext,
    collectionId: string,
    idempotencyKey: string,
    input: SetCollectionStatusInput,
  ) {
    const proof = await this.authorize(context);
    return this.repository.setCollectionStatus(proof, {
      tenantId: context.tenant.id,
      collectionId,
      status: input.status,
      archiveReason: input.archiveReason ?? null,
      idempotencyKey,
    });
  }

  async setCollectionProducts(
    context: AuthorizationContext,
    collectionId: string,
    idempotencyKey: string,
    productIds: readonly string[],
  ) {
    const proof = await this.authorize(context);
    return this.repository.setCollectionProducts(proof, {
      tenantId: context.tenant.id,
      collectionId,
      productIds: [...productIds],
      idempotencyKey,
    });
  }
}
