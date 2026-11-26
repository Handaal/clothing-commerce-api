import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import type {
  ChannelStockMode,
  InventoryChannelBalance,
} from "../contracts/management/inventory-channels";
import type { ChannelAllocationLineCommand, InventoryChannelRepository } from "./channel-service";
import { InventoryError, type ChannelSplitConflict } from "./errors";

const INVENTORY_PRIVATE_SCHEMA = "inventory_private";

const Int = z.union([z.number(), z.string()]);

function safeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error("Channel stock quantity is outside the supported application range.");
  }
  return parsed;
}

const AvailabilityRowSchema = z.object({
  variant_id: z.string().uuid(),
  canonical_on_hand: Int,
  website_on_hand: Int,
  website_reserved: Int,
  website_available: Int,
  pos_on_hand: Int,
  pos_reserved: Int,
  pos_available: Int,
  unallocated_on_hand: Int,
  mismatch: Int,
  explicitly_allocated: z.boolean(),
});

const VersionRowSchema = z.object({
  variant_id: z.string().uuid(),
  balance_version: Int,
  allocation_version: Int,
});

const ConflictDetailSchema = z.object({
  stale: z.array(
    z.object({
      variantId: z.string().uuid(),
      balanceVersion: Int,
      allocationVersion: Int,
      websiteOnHand: Int,
      posOnHand: Int,
      unallocatedOnHand: Int,
      posReserved: Int,
    }),
  ),
});

const ModeRowSchema = z.object({
  channel_stock_mode: z.enum(["legacy", "shadow", "enforced"]),
});

interface DatabaseErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly details?: string | null;
}

function parseConflicts(details: string | null | undefined): ChannelSplitConflict[] | undefined {
  if (!details) return undefined;
  try {
    const parsed = ConflictDetailSchema.parse(JSON.parse(details));
    return parsed.stale.map((line) => ({
      variantId: line.variantId,
      balanceVersion: safeInteger(line.balanceVersion),
      allocationVersion: safeInteger(line.allocationVersion),
      websiteOnHand: safeInteger(line.websiteOnHand),
      posOnHand: safeInteger(line.posOnHand),
      unallocatedOnHand: safeInteger(line.unallocatedOnHand),
      posReserved: safeInteger(line.posReserved),
    }));
  } catch {
    return undefined;
  }
}

/**
 * Maps channel SQLSTATEs (see the 20261114140000 migration) to stable inventory errors. Raw database
 * messages never escape. CH404 after the service has resolved the location means an unknown variant.
 */
function mapChannelError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "CH404":
      return new InventoryError("VARIANT_NOT_FOUND");
    case "CH409":
      return new InventoryError("CONCURRENT_MODIFICATION", parseConflicts(error.details));
    case "CH428":
      return new InventoryError("CHANNEL_ALLOCATION_INVALID");
    case "CH412":
      return new InventoryError("CHANNELS_NOT_INITIALIZED");
    case "CH422":
      return new InventoryError("CHANNEL_ALLOCATION_INVALID");
    case "ID409":
      return new InventoryError("IDEMPOTENCY_CONFLICT");
    case "23503":
      return new InventoryError("TENANT_MISMATCH");
    case "22003":
    case "22023":
    case "22P02":
      return new InventoryError("INVALID_QUANTITY");
    default:
      return new Error("An unexpected channel stock persistence error occurred.");
  }
}

export class SupabaseInventoryChannelRepository implements InventoryChannelRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getMode(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<ChannelStockMode | null> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .from("inventory_locations")
      .select("channel_stock_mode")
      .eq("tenant_id", tenantId)
      .eq("id", inventoryLocationId)
      .limit(1);
    if (error) {
      throw mapChannelError(error);
    }
    const row = (data ?? [])[0];
    return row === undefined ? null : ModeRowSchema.parse(row).channel_stock_mode;
  }

  async listBalances(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryChannelBalance[]> {
    assertAuthorizedOperationProof(proof);
    const [availability, versionResult] = await Promise.all([
      this.client
        .schema(INVENTORY_PRIVATE_SCHEMA)
        .rpc("channel_availability", { p_tenant_id: tenantId, p_location_id: inventoryLocationId }),
      this.client
        .schema(INVENTORY_PRIVATE_SCHEMA)
        .rpc("channel_versions", { p_tenant_id: tenantId, p_location_id: inventoryLocationId }),
    ]);
    if (availability.error) {
      throw mapChannelError(availability.error);
    }
    if (versionResult.error) {
      throw mapChannelError(versionResult.error);
    }
    const versions = new Map(
      z
        .array(VersionRowSchema)
        .parse(versionResult.data ?? [])
        .map((row) => [row.variant_id, row]),
    );
    const rows = z.array(AvailabilityRowSchema).parse(availability.data ?? []);
    return rows
      .map((row) => ({
        variantId: row.variant_id,
        canonicalOnHand: safeInteger(row.canonical_on_hand),
        websiteOnHand: safeInteger(row.website_on_hand),
        websiteReserved: safeInteger(row.website_reserved),
        websiteAvailable: safeInteger(row.website_available),
        posOnHand: safeInteger(row.pos_on_hand),
        posReserved: safeInteger(row.pos_reserved),
        posAvailable: safeInteger(row.pos_available),
        unallocatedOnHand: safeInteger(row.unallocated_on_hand),
        mismatch: safeInteger(row.mismatch),
        explicitlyAllocated: row.explicitly_allocated,
        balanceVersion: safeInteger(versions.get(row.variant_id)?.balance_version ?? 0),
        allocationVersion: safeInteger(versions.get(row.variant_id)?.allocation_version ?? 0),
      }))
      .sort((a, b) => a.variantId.localeCompare(b.variantId));
  }

  async initialize(
    proof: AuthorizedOperationContext,
    command: { tenantId: string; inventoryLocationId: string; actorMembershipId: string },
  ): Promise<string | null> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .schema(INVENTORY_PRIVATE_SCHEMA)
      .rpc("initialize_channel_stock", {
        p_tenant_id: command.tenantId,
        p_location_id: command.inventoryLocationId,
        p_actor_membership_id: command.actorMembershipId,
      });
    if (error) {
      // Already initialized: the call is naturally idempotent; the caller reads the current mode.
      if (error.code === "CH409") {
        return null;
      }
      throw mapChannelError(error);
    }
    return z.string().uuid().parse(data);
  }

  async allocate(
    proof: AuthorizedOperationContext,
    command: {
      tenantId: string;
      inventoryLocationId: string;
      actorMembershipId: string;
      reason: string;
      idempotencyKey: string;
      lines: readonly ChannelAllocationLineCommand[];
    },
  ): Promise<string> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .schema(INVENTORY_PRIVATE_SCHEMA)
      .rpc("allocate_channel_stock_v2", {
        p_tenant_id: command.tenantId,
        p_location_id: command.inventoryLocationId,
        p_actor_membership_id: command.actorMembershipId,
        p_reason: command.reason,
        p_idempotency_key: command.idempotencyKey,
        p_lines: command.lines.map((line) => ({
          variantId: line.variantId,
          websiteQuantity: line.websiteQuantity,
          posQuantity: line.posQuantity,
          expectedBalanceVersion: line.expectedBalanceVersion,
          expectedAllocationVersion: line.expectedAllocationVersion,
        })),
      });
    if (error) {
      throw mapChannelError(error);
    }
    return z.string().uuid().parse(data);
  }
}

export function createSupabaseInventoryChannelRepository(configuration: {
  readonly url: string;
  readonly serviceRoleKey: string;
}): SupabaseInventoryChannelRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseInventoryChannelRepository(client);
}
