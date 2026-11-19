import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { AuthorizationContext, AuthorizationService } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import {
  ReturnRequestSchema,
  type ReturnRequest,
  type ReturnRequestListQuery,
  type ReturnRequestListResponse,
  ReturnRequestListQuerySchema,
  type UpdateReturnRequestStatus,
} from "../contracts/management/return-requests";
import {
  ReturnRequestRefusalSchema,
  type StorefrontReturnRequest,
  StorefrontReturnRequestSchema,
  type StorefrontReturnRequestResponse,
  type StorefrontTrackedOrder,
  type StorefrontTrackOrderRequest,
  type TrackingStage,
} from "../contracts/storefront/after-purchase";

const errors = {
  ORDER_NOT_FOUND: [404, "No order matches that order number and phone number."],
  TOO_MANY_ATTEMPTS: [429, "Too many attempts for this order number. Try again in 15 minutes."],
  INVALID_RETURN_REQUEST: [400, "The return request is not valid."],
  RETURN_QUANTITY_EXCEEDED: [409, "That is more than can still be returned from this order."],
  RETURNS_DISABLED: [422, "This store isn't accepting online return requests."],
  ORDER_CANCELLED: [422, "This order was cancelled."],
  RETURN_WINDOW_EXPIRED: [422, "The return window for this order has ended."],
  NOT_YET_DELIVERED: [422, "Items can be returned once they have been delivered."],
  NOTHING_TO_RETURN: [422, "Everything on this order has already been returned or requested."],
  RETURN_REQUEST_NOT_FOUND: [404, "The return request was not found."],
  RETURN_REQUEST_STATUS_CONFLICT: [409, "The return request can't move to that status."],
} as const;
export type AfterPurchaseErrorCode = keyof typeof errors;

/** Mapped by both the public and the management runners (code + httpStatus). */
export class AfterPurchaseError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: AfterPurchaseErrorCode) {
    super(errors[code][1]);
    this.name = "AfterPurchaseError";
    this.httpStatus = errors[code][0];
  }
}

function databaseError(error: { code?: string }): Error {
  if (error.code === "TR429") return new AfterPurchaseError("TOO_MANY_ATTEMPTS");
  if (error.code === "RQ404") return new AfterPurchaseError("RETURN_REQUEST_NOT_FOUND");
  if (error.code === "RQ409") return new AfterPurchaseError("RETURN_REQUEST_STATUS_CONFLICT");
  if (error.code === "22P02") return new AfterPurchaseError("RETURN_REQUEST_NOT_FOUND");
  return new Error("An unexpected after-purchase persistence error occurred.");
}

/** The raw shape returned by online_private.track_storefront_order. */
export const TrackedOrderRowSchema = z.object({
  orderReference: z.string(),
  status: z.enum(["placed", "cancelled"]),
  placedAt: z.string(),
  cancelledAt: z.string().nullable(),
  lastFulfilledAt: z.string().nullable(),
  currency: z.string(),
  totalMinor: z.number().int(),
  grossSubtotalMinor: z.number().int(),
  discountTotalMinor: z.number().int(),
  deliveryFeeMinor: z.number().int(),
  payment: z
    .object({
      method: z.enum(["cash", "cash_on_delivery", "electronic"]),
      status: z.enum(["pending", "authorized", "captured", "failed", "cancelled", "refunded"]),
    })
    .nullable(),
  recipientName: z.string(),
  deliveryCity: z.string().nullable(),
  deliveryRegion: z.string().nullable(),
  lines: z.array(
    z.object({
      lineNumber: z.number().int(),
      productName: z.string(),
      variantName: z.string().nullable(),
      optionSummary: z.string().nullable(),
      quantity: z.number().int(),
      unitPriceMinor: z.number().int(),
      lineTotalMinor: z.number().int(),
      fulfilledQuantity: z.number().int(),
      returnedQuantity: z.number().int(),
      requestedQuantity: z.number().int(),
      returnableQuantity: z.number().int(),
    }),
  ),
  returns: z.object({
    accepting: z.boolean(),
    reason: ReturnRequestRefusalSchema.nullable(),
    windowDays: z.number().int().nullable(),
    windowEndsAt: z.string().nullable(),
  }),
  returnRequests: z.array(
    z.object({
      reference: z.string(),
      status: z.enum(["requested", "approved", "declined", "completed"]),
      preference: z.enum(["refund", "exchange"]),
      createdAt: z.string(),
      lines: z.array(z.object({ lineNumber: z.number().int(), quantity: z.number().int() })),
    }),
  ),
});
export type TrackedOrderRow = z.infer<typeof TrackedOrderRowSchema>;

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

/** Pure: where the order is, for the shopper. */
export function trackingStage(row: TrackedOrderRow): TrackingStage {
  if (row.status === "cancelled") return "cancelled";
  const ordered = row.lines.reduce((sum, line) => sum + line.quantity, 0);
  const shipped = row.lines.reduce((sum, line) => sum + line.fulfilledQuantity, 0);
  if (shipped === 0) return "confirmed";
  if (shipped < ordered) return "partially_shipped";
  return row.payment?.status === "captured" ? "delivered" : "shipped";
}

export function toTrackedOrder(row: TrackedOrderRow): StorefrontTrackedOrder {
  return {
    orderReference: row.orderReference,
    stage: trackingStage(row),
    placedAt: new Date(row.placedAt).toISOString(),
    cancelledAt: iso(row.cancelledAt),
    lastShippedAt: iso(row.lastFulfilledAt),
    currency: row.currency,
    totalMinor: row.totalMinor,
    grossSubtotalMinor: row.grossSubtotalMinor,
    discountTotalMinor: row.discountTotalMinor,
    deliveryFeeMinor: row.deliveryFeeMinor,
    payment: row.payment,
    recipientName: row.recipientName,
    deliveryCity: row.deliveryCity,
    deliveryRegion: row.deliveryRegion,
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productName: line.productName,
      variantName: line.variantName,
      optionSummary: line.optionSummary,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      shippedQuantity: line.fulfilledQuantity,
      returnedQuantity: line.returnedQuantity,
      requestedQuantity: line.requestedQuantity,
      returnableQuantity: line.returnableQuantity,
    })),
    returns: { ...row.returns, windowEndsAt: iso(row.returns.windowEndsAt) },
    returnRequests: row.returnRequests.map((request) => ({
      ...request,
      createdAt: new Date(request.createdAt).toISOString(),
    })),
  };
}

function toReturnRequest(raw: unknown): ReturnRequest {
  const row = z
    .object({ createdAt: z.string(), decidedAt: z.string().nullable() })
    .passthrough()
    .parse(raw);
  return ReturnRequestSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    decidedAt: iso(row.decidedAt),
  });
}

export interface AfterPurchaseRepository {
  track(input: {
    tenantId: string;
    brandId: string | null;
    orderReference: string;
    phone: string;
  }): Promise<TrackedOrderRow | null>;
  requestReturn(input: {
    tenantId: string;
    brandId: string | null;
    orderReference: string;
    phone: string;
    preference: "refund" | "exchange";
    note: string | null;
    lines: { lineNumber: number; quantity: number; reason: string }[];
  }): Promise<{ request: StorefrontReturnRequestResponse } | { refusal: string }>;
  list(
    tenantId: string,
    query: z.output<typeof ReturnRequestListQuerySchema>,
  ): Promise<ReturnRequestListResponse>;
  requestBrand(tenantId: string, requestId: string): Promise<string | null>;
  setStatus(input: {
    tenantId: string;
    requestId: string;
    actorMembershipId: string;
    status: string;
    note: string | null;
  }): Promise<ReturnRequest>;
}

/** Server-only adapter: public writes and staff decisions go through the sanctioned functions. */
export class SupabaseAfterPurchaseRepository implements AfterPurchaseRepository {
  constructor(private readonly client: SupabaseClient) {}

  async track(input: {
    tenantId: string;
    brandId: string | null;
    orderReference: string;
    phone: string;
  }) {
    const { data, error } = await this.client
      .schema("online_private")
      .rpc("track_storefront_order", {
        p_tenant: input.tenantId,
        p_brand: input.brandId,
        p_reference: input.orderReference,
        p_phone: input.phone,
      });
    if (error) throw databaseError(error);
    return data ? TrackedOrderRowSchema.parse(data) : null;
  }

  async requestReturn(input: Parameters<AfterPurchaseRepository["requestReturn"]>[0]) {
    const { data, error } = await this.client
      .schema("online_private")
      .rpc("request_storefront_return", {
        p_tenant: input.tenantId,
        p_brand: input.brandId,
        p_reference: input.orderReference,
        p_phone: input.phone,
        p_preference: input.preference,
        p_note: input.note,
        p_lines: input.lines,
      });
    if (error) throw databaseError(error);
    return z
      .union([
        z.object({
          request: z.object({ reference: z.string(), status: z.literal("requested") }),
        }),
        z.object({ refusal: z.string() }),
      ])
      .parse(data);
  }

  async list(tenantId: string, query: z.output<typeof ReturnRequestListQuerySchema>) {
    const [listed, awaiting] = await Promise.all([
      this.client.schema("online_private").rpc("list_return_requests", {
        p_tenant: tenantId,
        p_status: query.status,
        p_order: query.orderId ?? null,
        p_limit: query.limit,
      }),
      this.client
        .from("return_requests")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "requested"),
    ]);
    if (listed.error) throw databaseError(listed.error);
    if (awaiting.error) throw new Error("An unexpected return request read error occurred.");
    const requests = z.array(z.unknown()).parse(listed.data).map(toReturnRequest);
    return { requests, awaitingDecision: awaiting.count ?? 0 };
  }

  async requestBrand(tenantId: string, requestId: string) {
    const { data, error } = await this.client
      .from("return_requests")
      .select("brand_id")
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
      .maybeSingle();
    if (error) throw databaseError(error);
    return data ? z.object({ brand_id: z.string().uuid() }).parse(data).brand_id : null;
  }

  async setStatus(input: Parameters<AfterPurchaseRepository["setStatus"]>[0]) {
    const { data, error } = await this.client
      .schema("online_private")
      .rpc("set_return_request_status", {
        p_tenant: input.tenantId,
        p_request: input.requestId,
        p_actor: input.actorMembershipId,
        p_status: input.status,
        p_note: input.note,
      });
    if (error) throw databaseError(error);
    return toReturnRequest(data);
  }
}

export class AfterPurchaseService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: AfterPurchaseRepository,
  ) {}

  /** PUBLIC. A wrong number and a wrong phone are indistinguishable. */
  async track(input: StorefrontTrackOrderRequest): Promise<StorefrontTrackedOrder> {
    const row = await this.repository.track({
      tenantId: input.tenantId,
      brandId: input.brandId ?? null,
      orderReference: input.orderReference,
      phone: input.phone,
    });
    if (!row) throw new AfterPurchaseError("ORDER_NOT_FOUND");
    return toTrackedOrder(row);
  }

  /** PUBLIC. Opens a request for staff; moves no stock or money. */
  async requestReturn(input: StorefrontReturnRequest): Promise<StorefrontReturnRequestResponse> {
    const parsed = StorefrontReturnRequestSchema.safeParse(input);
    if (!parsed.success) throw new AfterPurchaseError("INVALID_RETURN_REQUEST");
    const command = parsed.data;
    const result = await this.repository.requestReturn({
      tenantId: command.tenantId,
      brandId: command.brandId ?? null,
      orderReference: command.orderReference,
      phone: command.phone,
      preference: command.preference,
      note: command.note && command.note.length > 0 ? command.note : null,
      lines: command.lines,
    });
    if ("request" in result) return result.request;
    const code = Object.hasOwn(errors, result.refusal)
      ? (result.refusal as AfterPurchaseErrorCode)
      : "INVALID_RETURN_REQUEST";
    throw new AfterPurchaseError(code);
  }

  async list(
    context: AuthorizationContext,
    query: ReturnRequestListQuery,
  ): Promise<ReturnRequestListResponse> {
    const permitted = context.assignments.some((assignment) =>
      assignment.permissionKeys.includes("returns.read"),
    );
    if (!permitted) throw new AuthorizationError("PERMISSION_DENIED");
    return this.repository.list(context.tenant.id, ReturnRequestListQuerySchema.parse(query));
  }

  async setStatus(
    context: AuthorizationContext,
    requestId: string,
    input: UpdateReturnRequestStatus,
  ): Promise<ReturnRequest> {
    const brandId = await this.repository.requestBrand(context.tenant.id, requestId);
    if (!brandId) throw new AfterPurchaseError("RETURN_REQUEST_NOT_FOUND");
    const proof = await this.authorization.authorize(context, {
      permissionKey: "returns.create",
      resources: [{ kind: "brand", id: brandId }],
    });
    return this.repository.setStatus({
      tenantId: context.tenant.id,
      requestId,
      actorMembershipId: proof.authorization.membership.id,
      status: input.status,
      note: input.note && input.note.length > 0 ? input.note : null,
    });
  }
}

export function createSupabaseAfterPurchaseRepository(configuration: {
  readonly url: string;
  readonly serviceRoleKey: string;
}): SupabaseAfterPurchaseRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseAfterPurchaseRepository(client);
}
