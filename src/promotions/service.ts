import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import {
  CreatePromotionRequestSchema,
  UpdatePromotionRequestSchema,
  CreatePromotionCodeRequestSchema,
  PromotionStatusSchema,
  PromotionCodeStatusSchema,
  type CreatePromotionRequest,
  type UpdatePromotionRequest,
  type CreatePromotionCodeRequest,
} from "../contracts/management/promotions";
import { PromotionError } from "./errors";
import type { PromotionsRepository } from "./repository";

export const PromotionPermission = {
  read: "promotions.read",
  manage: "promotions.manage",
} as const;

export function promotionCapabilities(context: AuthorizationContext) {
  const has = (key: string) =>
    context.assignments.some((a) => a.scopeMode === "tenant" && a.permissionKeys.includes(key));
  return { canRead: has(PromotionPermission.read), canManage: has(PromotionPermission.manage) };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new PromotionError("INVALID_PROMOTION");
  return result.data;
}

export interface PromotionListQuery {
  readonly limit: number;
  readonly offset: number;
}

export class PromotionsService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: PromotionsRepository,
  ) {}
  private authorize(context: AuthorizationContext, permissionKey: string) {
    return this.authorization.authorize(context, { permissionKey });
  }
  async list(context: AuthorizationContext, query: PromotionListQuery) {
    const proof = await this.authorize(context, PromotionPermission.read);
    return this.repository.list(proof, query.limit, query.offset);
  }
  async detail(context: AuthorizationContext, id: string) {
    const proof = await this.authorize(context, PromotionPermission.read);
    return this.repository.detail(proof, parse(z.uuid(), id));
  }
  async create(context: AuthorizationContext, key: string, input: CreatePromotionRequest) {
    const proof = await this.authorize(context, PromotionPermission.manage);
    return this.repository.create(proof, key, parse(CreatePromotionRequestSchema, input));
  }
  async update(context: AuthorizationContext, id: string, input: UpdatePromotionRequest) {
    const proof = await this.authorize(context, PromotionPermission.manage);
    return this.repository.update(
      proof,
      parse(z.uuid(), id),
      parse(UpdatePromotionRequestSchema, input),
    );
  }
  async setStatus(context: AuthorizationContext, id: string, status: unknown) {
    const proof = await this.authorize(context, PromotionPermission.manage);
    return this.repository.setStatus(
      proof,
      parse(z.uuid(), id),
      parse(PromotionStatusSchema, status),
    );
  }
  async createCode(
    context: AuthorizationContext,
    promotionId: string,
    input: CreatePromotionCodeRequest,
  ) {
    const proof = await this.authorize(context, PromotionPermission.manage);
    return this.repository.createCode(
      proof,
      parse(z.uuid(), promotionId),
      parse(CreatePromotionCodeRequestSchema, input),
    );
  }
  async setCodeStatus(context: AuthorizationContext, codeId: string, status: unknown) {
    const proof = await this.authorize(context, PromotionPermission.manage);
    return this.repository.setCodeStatus(
      proof,
      parse(z.uuid(), codeId),
      parse(PromotionCodeStatusSchema, status),
    );
  }
}
