import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  ReturnDetailResponseSchema,
  ReturnEligibilityResponseSchema,
  ReturnHistoryResponseSchema,
  OrderReturnSummarySchema,
  type ReturnCommand,
} from "../contracts/management/returns";
import { ReturnError, returnDatabaseError } from "./errors";

const RoutingSchema = z.object({
  channel: z.enum(["pos", "online"]),
  brand_id: z.uuid(),
  branch_id: z.uuid().nullable(),
});
export class ReturnsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async orderRouting(tenantId: string, orderId: string) {
    const { data, error } = await this.client
      .from("orders")
      .select("channel,brand_id,branch_id")
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .maybeSingle();
    if (error) throw returnDatabaseError(error);
    if (!data) throw new ReturnError("RETURN_NOT_FOUND");
    return RoutingSchema.parse(data);
  }
  async returnOrderId(tenantId: string, returnId: string): Promise<string> {
    const { data, error } = await this.client
      .from("returns")
      .select("order_id")
      .eq("tenant_id", tenantId)
      .eq("id", returnId)
      .maybeSingle();
    if (error) throw returnDatabaseError(error);
    if (!data) throw new ReturnError("RETURN_NOT_FOUND");
    return z.object({ order_id: z.uuid() }).parse(data).order_id;
  }
  private async rpc(
    proof: AuthorizedOperationContext,
    name: string,
    args: Record<string, unknown>,
  ) {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .schema("returns_private")
      .rpc(name, { p_tenant: proof.authorization.tenant.id, ...args });
    if (error) throw returnDatabaseError(error);
    return data;
  }
  async eligibility(proof: AuthorizedOperationContext, orderId: string) {
    return ReturnEligibilityResponseSchema.parse(
      await this.rpc(proof, "return_eligibility", { p_order: orderId }),
    );
  }
  async detail(proof: AuthorizedOperationContext, returnId: string) {
    const data = await this.rpc(proof, "return_detail", { p_return: returnId });
    if (!data) throw new ReturnError("RETURN_NOT_FOUND");
    return ReturnDetailResponseSchema.parse(data);
  }
  async create(
    proof: AuthorizedOperationContext,
    orderId: string,
    key: string,
    source: string,
    command: ReturnCommand,
  ) {
    return ReturnDetailResponseSchema.parse(
      await this.rpc(proof, "accept_return", {
        p_order: orderId,
        p_actor: proof.authorization.membership.id,
        p_source: source,
        p_key: key,
        p_intent: command,
      }),
    );
  }
  async settle(
    proof: AuthorizedOperationContext,
    returnId: string,
    key: string,
    reference: string,
  ) {
    return ReturnDetailResponseSchema.parse(
      await this.rpc(proof, "settle_manual_refund", {
        p_return: returnId,
        p_actor: proof.authorization.membership.id,
        p_key: key,
        p_reference: reference,
      }),
    );
  }
  async history(
    proof: AuthorizedOperationContext,
    orderId: string,
    limit: number,
    cursor?: string,
  ) {
    assertAuthorizedOperationProof(proof);
    let query = this.client
      .from("returns")
      .select("id")
      .eq("tenant_id", proof.authorization.tenant.id)
      .eq("order_id", orderId)
      .order("id")
      .limit(limit + 1);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw returnDatabaseError(error);
    const rows = z.array(z.object({ id: z.uuid() })).parse(data);
    const items = await Promise.all(rows.slice(0, limit).map((row) => this.detail(proof, row.id)));
    return ReturnHistoryResponseSchema.parse({
      items,
      pageInfo: {
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit ? rows[limit - 1].id : null,
      },
    });
  }
  async summary(proof: AuthorizedOperationContext, orderId: string) {
    return OrderReturnSummarySchema.parse(
      await this.rpc(proof, "order_return_summary", { p_order: orderId }),
    );
  }
}
export function createReturnsRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new ReturnsRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
