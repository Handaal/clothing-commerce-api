import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  PromotionDetailSchema,
  PromotionListResponseSchema,
  type CreatePromotionRequest,
  type UpdatePromotionRequest,
} from "../contracts/management/promotions";
import { PromotionError, promotionDatabaseError } from "./errors";

const SCHEMA = "promotions_private";

export class PromotionsRepository {
  constructor(private readonly client: SupabaseClient) {}
  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }
  private detailOrThrow(data: unknown) {
    if (data === null || data === undefined) throw new PromotionError("PROMOTION_NOT_FOUND");
    return PromotionDetailSchema.parse(data);
  }

  async list(proof: AuthorizedOperationContext, limit: number, offset: number) {
    const { data, error } = await this.client.schema(SCHEMA).rpc("list_promotions", {
      p_tenant: this.tenant(proof),
      p_limit: limit,
      p_offset: offset,
    });
    if (error) throw promotionDatabaseError(error);
    return PromotionListResponseSchema.parse(data);
  }
  async detail(proof: AuthorizedOperationContext, id: string) {
    const { data, error } = await this.client.schema(SCHEMA).rpc("promotion_detail", {
      p_tenant: this.tenant(proof),
      p_id: id,
    });
    if (error) throw promotionDatabaseError(error);
    return this.detailOrThrow(data);
  }
  async create(proof: AuthorizedOperationContext, key: string, payload: CreatePromotionRequest) {
    const { data, error } = await this.client.schema(SCHEMA).rpc("create_promotion", {
      p_tenant: this.tenant(proof),
      p_key: key,
      p_payload: payload,
    });
    if (error) throw promotionDatabaseError(error);
    return this.detailOrThrow(data);
  }
  async update(proof: AuthorizedOperationContext, id: string, payload: UpdatePromotionRequest) {
    const { data, error } = await this.client.schema(SCHEMA).rpc("update_promotion", {
      p_tenant: this.tenant(proof),
      p_id: id,
      p_payload: payload,
    });
    if (error) throw promotionDatabaseError(error);
    return this.detailOrThrow(data);
  }
  async setStatus(proof: AuthorizedOperationContext, id: string, status: "active" | "inactive") {
    const { data, error } = await this.client.schema(SCHEMA).rpc("set_promotion_status", {
      p_tenant: this.tenant(proof),
      p_id: id,
      p_status: status,
    });
    if (error) throw promotionDatabaseError(error);
    return this.detailOrThrow(data);
  }
  async createCode(
    proof: AuthorizedOperationContext,
    promotionId: string,
    payload: { code: string; maxRedemptions?: number | null },
  ) {
    const { data, error } = await this.client.schema(SCHEMA).rpc("create_code", {
      p_tenant: this.tenant(proof),
      p_promotion: promotionId,
      p_payload: payload,
    });
    if (error) throw promotionDatabaseError(error);
    return this.detailOrThrow(data);
  }
  async setCodeStatus(
    proof: AuthorizedOperationContext,
    codeId: string,
    status: "active" | "disabled",
  ) {
    const { data, error } = await this.client.schema(SCHEMA).rpc("set_code_status", {
      p_tenant: this.tenant(proof),
      p_code: codeId,
      p_status: status,
    });
    if (error) throw promotionDatabaseError(error);
    return this.detailOrThrow(data);
  }
}

export function createPromotionsRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new PromotionsRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
