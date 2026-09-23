import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { SupabaseFulfillmentRepository } from "../fulfillments/supabase-fulfillment-repository";
import { OrderPermission } from "../orders/model";
import { SupabaseOrdersRepository } from "../orders/supabase-orders-repository";
import { assertPosSaleExecutionProof, type PosSaleExecutionProof } from "./execution-proof";
import { PosSaleError } from "./errors";
import type {
  PaymentResult,
  PosRegisterContext,
  PosSaleIntent,
  PosSaleReplayTarget,
  PosSaleResult,
} from "./model";
import type {
  PosSaleRepository,
  PromotionEvaluationInput,
  RecordPosSaleCommand,
} from "./repository";

const PRIVATE_SCHEMA = "pos_sales_private";

function safeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error("A POS sale amount is outside the supported application range.");
  }
  return parsed;
}

function isoDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("A POS sale timestamp is invalid.");
  return parsed.toISOString();
}

const ReplaySchema = z.object({
  fingerprint_matches: z.boolean(),
  sale_id: z.string().uuid().nullable(),
  branch_id: z.string().uuid().nullable(),
  inventory_location_id: z.string().uuid().nullable(),
});

const RegisterSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  status: z.enum(["active", "inactive", "archived"]),
  branch_id: z.string().uuid(),
  default_inventory_location_id: z.string().uuid(),
  selling_currency: z.string().regex(/^[A-Z]{3}$/),
});

const BranchSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  status: z.enum(["active", "inactive", "archived"]),
});

const LocationSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  status: z.enum(["active", "inactive", "archived"]),
  is_fulfillment_enabled: z.boolean(),
});

const SaleSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  fulfillment_id: z.string().uuid(),
});

const EvaluationSchema = z.object({
  applied: z.boolean(),
  codeStatus: z.enum(["none", "valid", "invalid"]),
  discountTotalMinor: z.number().int().nonnegative().optional(),
  promotionId: z.string().uuid().nullable().optional(),
  codeId: z.string().uuid().nullable().optional(),
  promotionName: z.string().nullable().optional(),
  benefitType: z.enum(["percentage", "fixed_amount"]).nullable().optional(),
  codeSnapshot: z.string().nullable().optional(),
});

const PaymentSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  method: z.literal("cash"),
  status: z.literal("captured"),
  currency: z.string(),
  amount_minor: z.union([z.number(), z.string()]),
  cash_received_minor: z.union([z.number(), z.string()]),
  change_minor: z.union([z.number(), z.string()]),
  captured_by_membership_id: z.string().uuid(),
  captured_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

interface DatabaseErrorLike {
  readonly code?: string;
  readonly details?: string;
  readonly message?: string;
}

function mapError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "ID409":
      return new PosSaleError("IDEMPOTENCY_CONFLICT");
    case "PS409": {
      const total = error.details === undefined ? undefined : Number(error.details);
      return new PosSaleError(
        "PRICE_CHANGED",
        typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : undefined,
      );
    }
    case "PS010":
      return new PosSaleError("REGISTER_NOT_FOUND");
    case "PS011":
      return new PosSaleError("REGISTER_INACTIVE");
    case "PS012":
      return new PosSaleError("BRANCH_INACTIVE");
    case "PS013":
      return new PosSaleError("LOCATION_INACTIVE");
    case "PS014":
      return new PosSaleError("LOCATION_CAPABILITY_DENIED");
    case "PS020":
      return new PosSaleError("VARIANT_NOT_FOUND");
    case "PS021":
      return new PosSaleError("VARIANT_INACTIVE");
    case "PS022":
      return new PosSaleError("PRICE_NOT_FOUND");
    case "PS023":
      return new PosSaleError("BRAND_NOT_AVAILABLE_AT_BRANCH");
    case "PS024":
      return new PosSaleError("CROSS_BRAND_ORDER");
    case "PS030":
      return new PosSaleError("CASH_RECEIVED_INSUFFICIENT");
    case "23514":
      return new PosSaleError("INSUFFICIENT_STOCK");
    case "23503":
      return new PosSaleError("TENANT_MISMATCH");
    case "22003":
      return new PosSaleError("AMOUNT_OUT_OF_RANGE");
    case "22004":
    case "22023":
    case "22P02":
      return new PosSaleError("INVALID_POS_SALE");
    default:
      return new Error(
        `An unexpected POS sale persistence error occurred (${error.code ?? "unknown"}: ${error.message ?? "no message"}).`,
      );
  }
}

export class SupabasePosSaleRepository implements PosSaleRepository {
  private readonly orders: SupabaseOrdersRepository;
  private readonly fulfillments: SupabaseFulfillmentRepository;

  constructor(private readonly client: SupabaseClient) {
    this.orders = new SupabaseOrdersRepository(client);
    this.fulfillments = new SupabaseFulfillmentRepository(client);
  }

  async resolveReplayTarget(
    tenantId: string,
    normalizedIdempotencyKey: string,
    intent: PosSaleIntent,
  ): Promise<PosSaleReplayTarget> {
    const { data, error } = await this.client.schema(PRIVATE_SCHEMA).rpc("resolve_replay_target", {
      p_tenant_id: tenantId,
      p_normalized_key: normalizedIdempotencyKey,
      p_intent: {
        register_id: intent.registerId,
        expected_total_minor: intent.expectedTotalMinor,
        cash_received_minor: intent.cashReceivedMinor,
        promotion_code: intent.promotionCode,
        lines: intent.lines.map((line) => ({
          variant_id: line.variantId,
          quantity: line.quantity,
        })),
      },
    });
    if (error) throw mapError(error);
    const rows = Array.isArray(data) ? data : data === null ? [] : [data];
    if (rows.length === 0) return { kind: "none" };
    const row = ReplaySchema.parse(rows[0]);
    if (!row.fingerprint_matches) {
      if (!row.branch_id || !row.inventory_location_id) {
        throw new Error("A POS conflict target omitted persisted routing.");
      }
      return {
        kind: "conflict",
        branchId: row.branch_id,
        inventoryLocationId: row.inventory_location_id,
      };
    }
    if (!row.sale_id || !row.branch_id || !row.inventory_location_id) {
      throw new Error("A POS replay target omitted persisted routing.");
    }
    return {
      kind: "replay",
      saleId: row.sale_id,
      branchId: row.branch_id,
      inventoryLocationId: row.inventory_location_id,
    };
  }

  async listRegisterContexts(tenantId: string): Promise<readonly PosRegisterContext[]> {
    const { data, error } = await this.client
      .from("registers")
      .select("id,display_name,status,branch_id,default_inventory_location_id,selling_currency")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .order("display_name")
      .order("id");
    if (error) throw mapError(error);
    const registers = (data ?? []).map((row) => RegisterSchema.parse(row));
    return this.hydrateRegisters(tenantId, registers);
  }

  async getRegisterContext(
    tenantId: string,
    registerId: string,
  ): Promise<PosRegisterContext | null> {
    const { data, error } = await this.client
      .from("registers")
      .select("id,display_name,status,branch_id,default_inventory_location_id,selling_currency")
      .eq("tenant_id", tenantId)
      .eq("id", registerId)
      .eq("status", "active")
      .limit(1);
    if (error) throw mapError(error);
    const registers = (data ?? []).map((row) => RegisterSchema.parse(row));
    if (registers.length === 0) return null;
    return (await this.hydrateRegisters(tenantId, registers))[0] ?? null;
  }

  async recordSale(proof: PosSaleExecutionProof, command: RecordPosSaleCommand): Promise<string> {
    assertPosSaleExecutionProof(proof);
    const { data, error } = await this.client.schema(PRIVATE_SCHEMA).rpc("record_sale", {
      p_tenant_id: command.tenantId,
      p_register_id: command.registerId,
      p_actor_membership_id: command.actorMembershipId,
      p_idempotency_key: command.idempotencyKey,
      p_expected_total_minor: command.expectedTotalMinor,
      p_cash_received_minor: command.cashReceivedMinor,
      p_promotion_code: command.promotionCode,
      p_lines: command.lines.map((line) => ({
        variant_id: line.variantId,
        product_id: line.productId,
        brand_id: line.brandId,
        quantity: line.quantity,
        unit_price_minor: line.unitPriceMinor,
        product_name: line.productName,
        variant_name: line.variantName,
        sku: line.sku,
        option_summary: line.optionSummary,
      })),
    });
    if (error) throw mapError(error);
    const parsed = z.string().uuid().safeParse(data);
    if (!parsed.success) throw new Error("record_sale did not return a sale id.");
    return parsed.data;
  }

  async evaluatePromotion(input: PromotionEvaluationInput) {
    const { data, error } = await this.client.schema("promotions_private").rpc("evaluate", {
      p_tenant: input.tenantId,
      p_channel: "pos",
      p_currency: input.currency,
      p_brand: input.brandId,
      p_branch: input.branchId,
      p_code: input.promotionCode,
      p_lines: input.lines.map((line, index) => ({
        ord: index + 1,
        variantId: line.variantId,
        productId: line.productId,
        quantity: line.quantity,
        lineTotalMinor: line.lineTotalMinor,
      })),
    });
    if (error) throw mapError(error);
    const parsed = EvaluationSchema.parse(data);
    return {
      applied: parsed.applied,
      discountTotalMinor: parsed.discountTotalMinor ?? 0,
      codeStatus: parsed.codeStatus,
      promotion:
        parsed.applied && parsed.promotionId
          ? {
              promotionId: parsed.promotionId,
              name: parsed.promotionName ?? "",
              benefitType: parsed.benefitType ?? "percentage",
              activation: parsed.codeId ? ("code" as const) : ("automatic" as const),
              code: parsed.codeSnapshot ?? null,
              discountTotalMinor: parsed.discountTotalMinor ?? 0,
            }
          : null,
    };
  }

  async getSale(
    proof: PosSaleExecutionProof,
    tenantId: string,
    saleId: string,
  ): Promise<PosSaleResult | null> {
    assertPosSaleExecutionProof(proof);
    const { data, error } = await this.client
      .from("pos_sales")
      .select("id,order_id,payment_id,fulfillment_id")
      .eq("tenant_id", tenantId)
      .eq("id", saleId)
      .limit(1);
    if (error) throw mapError(error);
    const rows = data ?? [];
    if (rows.length === 0) return null;
    const sale = SaleSchema.parse(rows[0]);
    const readProof = proof.proofs.find(
      (candidate) => candidate.permissionKey === OrderPermission.read,
    );
    if (!readProof) throw new Error("A POS sale proof is missing orders.read.");
    const [order, fulfillment, payment] = await Promise.all([
      this.orders.getOrder(readProof, tenantId, sale.order_id),
      this.fulfillments.getFulfillment(readProof, tenantId, sale.fulfillment_id),
      this.loadPayment(tenantId, sale.payment_id),
    ]);
    if (!order || !fulfillment || !payment) {
      throw new Error("A committed POS sale is missing a component.");
    }
    return {
      saleStatus: "completed",
      order: {
        ...order,
        placedAt: isoDateTime(order.placedAt),
        cancelledAt: order.cancelledAt === null ? null : isoDateTime(order.cancelledAt),
        createdAt: isoDateTime(order.createdAt),
        updatedAt: isoDateTime(order.updatedAt),
      },
      payment,
      fulfillment: {
        ...fulfillment,
        fulfilledAt: isoDateTime(fulfillment.fulfilledAt),
        createdAt: isoDateTime(fulfillment.createdAt),
      },
    };
  }

  private async hydrateRegisters(
    tenantId: string,
    registers: readonly z.infer<typeof RegisterSchema>[],
  ): Promise<readonly PosRegisterContext[]> {
    if (registers.length === 0) return [];
    const branchIds = [...new Set(registers.map((register) => register.branch_id))];
    const locationIds = [
      ...new Set(registers.map((register) => register.default_inventory_location_id)),
    ];
    const [{ data: branchData, error: branchError }, { data: locationData, error: locationError }] =
      await Promise.all([
        this.client
          .from("branches")
          .select("id,display_name,status")
          .eq("tenant_id", tenantId)
          .in("id", branchIds),
        this.client
          .from("inventory_locations")
          .select("id,display_name,status,is_fulfillment_enabled")
          .eq("tenant_id", tenantId)
          .in("id", locationIds),
      ]);
    if (branchError) throw mapError(branchError);
    if (locationError) throw mapError(locationError);
    const branches = new Map(
      (branchData ?? []).map((row) => {
        const parsed = BranchSchema.parse(row);
        return [parsed.id, parsed] as const;
      }),
    );
    const locations = new Map(
      (locationData ?? []).map((row) => {
        const parsed = LocationSchema.parse(row);
        return [parsed.id, parsed] as const;
      }),
    );
    return registers.map((register) => {
      const foundBranch = branches.get(register.branch_id);
      const foundLocation = locations.get(register.default_inventory_location_id);
      if (!foundBranch || !foundLocation) {
        throw new Error("A register references unavailable selling context.");
      }
      return {
        registerId: register.id,
        registerName: register.display_name,
        registerStatus: register.status,
        branchId: foundBranch.id,
        branchName: foundBranch.display_name,
        branchStatus: foundBranch.status,
        inventoryLocationId: foundLocation.id,
        inventoryLocationName: foundLocation.display_name,
        inventoryLocationStatus: foundLocation.status,
        fulfillmentEnabled: foundLocation.is_fulfillment_enabled,
        sellingCurrency: register.selling_currency,
      };
    });
  }

  private async loadPayment(tenantId: string, paymentId: string): Promise<PaymentResult | null> {
    const { data, error } = await this.client
      .from("payments")
      .select(
        "id,order_id,method,status,currency,amount_minor,cash_received_minor,change_minor,captured_by_membership_id,captured_at,created_at,updated_at",
      )
      .eq("tenant_id", tenantId)
      .eq("id", paymentId)
      .limit(1);
    if (error) throw mapError(error);
    const rows = data ?? [];
    if (rows.length === 0) return null;
    const payment = PaymentSchema.parse(rows[0]);
    return {
      id: payment.id,
      orderId: payment.order_id,
      method: payment.method,
      status: payment.status,
      currency: payment.currency,
      amountMinor: safeInteger(payment.amount_minor),
      cashReceivedMinor: safeInteger(payment.cash_received_minor),
      changeMinor: safeInteger(payment.change_minor),
      capturedByMembershipId: payment.captured_by_membership_id,
      capturedAt: isoDateTime(payment.captured_at),
      createdAt: isoDateTime(payment.created_at),
      updatedAt: isoDateTime(payment.updated_at),
    };
  }
}

export interface SupabasePosSaleRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabasePosSaleRepository(
  configuration: SupabasePosSaleRepositoryConfiguration,
): SupabasePosSaleRepository {
  return new SupabasePosSaleRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    }),
  );
}
