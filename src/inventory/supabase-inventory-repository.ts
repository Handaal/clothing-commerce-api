import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import { InventoryError } from "./errors";
import type {
  InventoryBalanceResult,
  InventoryLocationState,
  InventoryMutationResult,
  InventoryObservedMutationResult,
  InventoryTransferResult,
  StockKey,
  VariantState,
} from "./model";
import type {
  InventoryRepository,
  RecordCountAdjustmentCommand,
  RecordIssueCommand,
  RecordOpeningCommand,
  RecordReceiptCommand,
  RecordTransferCommand,
} from "./repository";

// The private schema that owns the sanctioned mutation functions. It is exposed to PostgREST so the
// service-role client can call the functions by name; execution is gated by the EXECUTE grants
// (service_role only), never by schema exposure.
const INVENTORY_PRIVATE_SCHEMA = "inventory_private";

// A bigint column/return that must round-trip through JSON without precision loss. PostgREST may hand
// back int8 as a number or a string. The Phase 2C application contract carries quantities as JS safe
// integers (0..Number.MAX_SAFE_INTEGER) while the ledger stays bigint; a value outside that range is a
// numeric transport/invariant failure, NOT a business condition. It surfaces as a generic internal
// error (a future HTTP layer maps it to 500) and never as a domain error such as TENANT_MISMATCH,
// which would masquerade as a missing/cross-tenant resource. The raw value is never exposed.
function toSafeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error("Inventory quantity is outside the supported application range.");
  }
  return parsed;
}

const BalanceRowSchema = z.object({
  on_hand_quantity: z.union([z.number(), z.string()]),
  version: z.union([z.number(), z.string()]),
});

const VariantStateRowSchema = z.object({
  status: z.enum(["draft", "active", "archived"]),
});

const LocationStateRowSchema = z.object({
  status: z.enum(["active", "inactive", "archived"]),
  is_receiving_enabled: z.boolean(),
  is_transfer_origin_enabled: z.boolean(),
  is_transfer_destination_enabled: z.boolean(),
});

const SingleKeyResultRowSchema = z.object({
  operation_id: z.string().uuid().nullable(),
  previous_on_hand: z.union([z.number(), z.string()]),
  on_hand: z.union([z.number(), z.string()]),
  version: z.union([z.number(), z.string()]),
  changed: z.boolean().optional(),
});

interface DatabaseErrorLike {
  readonly code?: string;
}

/**
 * Maps a PostgREST/PostgreSQL error to a stable inventory error. Raw SQLSTATEs and database messages
 * never escape this function. An unexpected privilege failure (42501) from the sanctioned path is a
 * server defect, not a client error, so it surfaces as a generic Error, not an InventoryError.
 */
function mapDatabaseError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "23514":
      return new InventoryError("INSUFFICIENT_STOCK");
    case "ID409":
      return new InventoryError("IDEMPOTENCY_CONFLICT");
    case "IN001":
      return new InventoryError("OPENING_STOCK_ALREADY_EXISTS");
    case "IN002":
      return new InventoryError("CONCURRENT_MODIFICATION");
    case "23503":
      return new InventoryError("TENANT_MISMATCH");
    case "22003":
    case "22023":
    case "22P02":
    case "22004":
      return new InventoryError("INVALID_QUANTITY");
    default:
      return new Error("An unexpected inventory persistence error occurred.");
  }
}

/**
 * Server-only adapter around a service-role client. The client is deliberately private; this class
 * exposes no generic query/write escape hatch, no raw RPC name, and no signed-delta or movement-JSON
 * surface. Every method asserts the authorization proof before any privileged database access.
 */
export class SupabaseInventoryRepository implements InventoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getBalance(
    proof: AuthorizedOperationContext,
    key: StockKey,
  ): Promise<InventoryBalanceResult> {
    assertAuthorizedOperationProof(proof);

    const { data, error } = await this.client
      .from("inventory_balances")
      .select("on_hand_quantity,version")
      .eq("tenant_id", key.tenantId)
      .eq("variant_id", key.variantId)
      .eq("inventory_location_id", key.inventoryLocationId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return {
        variantId: key.variantId,
        inventoryLocationId: key.inventoryLocationId,
        onHand: 0,
        version: 0,
        exists: false,
      };
    }

    const row = BalanceRowSchema.parse(rows[0]);
    return {
      variantId: key.variantId,
      inventoryLocationId: key.inventoryLocationId,
      onHand: toSafeInteger(row.on_hand_quantity),
      version: toSafeInteger(row.version),
      exists: true,
    };
  }

  async getVariantState(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
  ): Promise<VariantState | null> {
    assertAuthorizedOperationProof(proof);

    const { data, error } = await this.client
      .from("product_variants")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("id", variantId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    return { status: VariantStateRowSchema.parse(rows[0]).status };
  }

  async getLocationState(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryLocationState | null> {
    assertAuthorizedOperationProof(proof);

    const { data, error } = await this.client
      .from("inventory_locations")
      .select(
        "status,is_receiving_enabled,is_transfer_origin_enabled,is_transfer_destination_enabled",
      )
      .eq("tenant_id", tenantId)
      .eq("id", inventoryLocationId)
      .limit(1);
    if (error) {
      throw mapDatabaseError(error);
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return null;
    }
    const row = LocationStateRowSchema.parse(rows[0]);
    return {
      status: row.status,
      isReceivingEnabled: row.is_receiving_enabled,
      isTransferOriginEnabled: row.is_transfer_origin_enabled,
      isTransferDestinationEnabled: row.is_transfer_destination_enabled,
    };
  }

  async recordOpening(
    proof: AuthorizedOperationContext,
    command: RecordOpeningCommand,
  ): Promise<InventoryMutationResult> {
    assertAuthorizedOperationProof(proof);

    const row = await this.callSingleKeyFunction("record_opening", {
      p_tenant_id: command.tenantId,
      p_variant_id: command.variantId,
      p_inventory_location_id: command.inventoryLocationId,
      p_quantity: command.quantity,
      p_actor_membership_id: command.actorMembershipId,
      p_idempotency_key: command.idempotencyKey,
      p_notes: command.note ?? null,
    });

    return this.singleKeyResult(command.variantId, command.inventoryLocationId, row, true);
  }

  async recordCountAdjustment(
    proof: AuthorizedOperationContext,
    command: RecordCountAdjustmentCommand,
  ): Promise<InventoryMutationResult> {
    assertAuthorizedOperationProof(proof);

    const row = await this.callSingleKeyFunction("record_count_adjustment", {
      p_tenant_id: command.tenantId,
      p_variant_id: command.variantId,
      p_inventory_location_id: command.inventoryLocationId,
      p_counted_quantity: command.countedQuantity,
      p_expected_version: command.expectedVersion,
      p_actor_membership_id: command.actorMembershipId,
      p_idempotency_key: command.idempotencyKey,
      p_notes: command.note ?? null,
    });

    return this.singleKeyResult(
      command.variantId,
      command.inventoryLocationId,
      row,
      row.changed ?? true,
    );
  }

  async recordReceipt(
    proof: AuthorizedOperationContext,
    command: RecordReceiptCommand,
  ): Promise<InventoryObservedMutationResult> {
    assertAuthorizedOperationProof(proof);

    const operationId = await this.callRecordOperation("receipt", command.tenantId, {
      actorMembershipId: command.actorMembershipId,
      idempotencyKey: command.idempotencyKey,
      note: command.note,
      movements: [
        {
          variant_id: command.variantId,
          inventory_location_id: command.inventoryLocationId,
          quantity_delta: command.quantity,
        },
      ],
    });

    // record_operation returns only the operation id; the balance is read after commit and is a
    // current observation, not an atomic before/after snapshot. No arithmetic reconstruction.
    const balance = await this.readBalanceEcho(proof, command);
    return {
      operationId,
      changed: true,
      variantId: command.variantId,
      inventoryLocationId: command.inventoryLocationId,
      observedOnHand: balance.onHand,
      observedVersion: balance.version,
    };
  }

  async recordIssue(
    proof: AuthorizedOperationContext,
    command: RecordIssueCommand,
  ): Promise<InventoryObservedMutationResult> {
    assertAuthorizedOperationProof(proof);

    const operationId = await this.callRecordOperation("issue", command.tenantId, {
      actorMembershipId: command.actorMembershipId,
      idempotencyKey: command.idempotencyKey,
      note: command.note,
      movements: [
        {
          variant_id: command.variantId,
          inventory_location_id: command.inventoryLocationId,
          quantity_delta: -command.quantity,
        },
      ],
    });

    // Observed post-commit balance; see recordReceipt. Not an atomic snapshot of this issue.
    const balance = await this.readBalanceEcho(proof, command);
    return {
      operationId,
      changed: true,
      variantId: command.variantId,
      inventoryLocationId: command.inventoryLocationId,
      observedOnHand: balance.onHand,
      observedVersion: balance.version,
    };
  }

  async recordTransfer(
    proof: AuthorizedOperationContext,
    command: RecordTransferCommand,
  ): Promise<InventoryTransferResult> {
    assertAuthorizedOperationProof(proof);

    // One atomic operation carrying both movements: -quantity at the source, +quantity at the
    // destination. Zero-sum is enforced here by construction; the ledger commits both or neither.
    const operationId = await this.callRecordOperation("transfer", command.tenantId, {
      actorMembershipId: command.actorMembershipId,
      idempotencyKey: command.idempotencyKey,
      note: command.note,
      movements: [
        {
          variant_id: command.variantId,
          inventory_location_id: command.sourceInventoryLocationId,
          quantity_delta: -command.quantity,
        },
        {
          variant_id: command.variantId,
          inventory_location_id: command.destinationInventoryLocationId,
          quantity_delta: command.quantity,
        },
      ],
    });

    // Both sides are read after commit and reported as current observed state, not atomic before/after
    // snapshots; under concurrency they may already reflect later committed operations.
    const source = await this.getBalance(proof, {
      tenantId: command.tenantId,
      variantId: command.variantId,
      inventoryLocationId: command.sourceInventoryLocationId,
    });
    const destination = await this.getBalance(proof, {
      tenantId: command.tenantId,
      variantId: command.variantId,
      inventoryLocationId: command.destinationInventoryLocationId,
    });

    return {
      operationId,
      variantId: command.variantId,
      source: {
        inventoryLocationId: command.sourceInventoryLocationId,
        observedOnHand: source.onHand,
        observedVersion: source.version,
      },
      destination: {
        inventoryLocationId: command.destinationInventoryLocationId,
        observedOnHand: destination.onHand,
        observedVersion: destination.version,
      },
    };
  }

  private async callSingleKeyFunction(
    functionName: "record_opening" | "record_count_adjustment",
    params: Record<string, unknown>,
  ): Promise<z.infer<typeof SingleKeyResultRowSchema>> {
    const { data, error } = await this.client
      .schema(INVENTORY_PRIVATE_SCHEMA)
      .rpc(functionName, params);
    if (error) {
      throw mapDatabaseError(error);
    }

    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0) {
      throw new Error("Inventory function returned no result row.");
    }
    return SingleKeyResultRowSchema.parse(rows[0]);
  }

  private async callRecordOperation(
    operationType: "receipt" | "issue" | "transfer",
    tenantId: string,
    input: {
      readonly actorMembershipId: string;
      readonly idempotencyKey: string;
      readonly note?: string;
      readonly movements: ReadonlyArray<{
        variant_id: string;
        inventory_location_id: string;
        quantity_delta: number;
      }>;
    },
  ): Promise<string> {
    const { data, error } = await this.client
      .schema(INVENTORY_PRIVATE_SCHEMA)
      .rpc("record_operation", {
        p_tenant_id: tenantId,
        p_operation_type: operationType,
        p_movements: input.movements,
        p_actor_membership_id: input.actorMembershipId,
        p_idempotency_key: input.idempotencyKey,
        p_notes: input.note ?? null,
      });
    if (error) {
      throw mapDatabaseError(error);
    }

    const operationId = z.string().uuid().safeParse(data);
    if (!operationId.success) {
      throw new Error("record_operation did not return an operation id.");
    }
    return operationId.data;
  }

  private async readBalanceEcho(
    proof: AuthorizedOperationContext,
    key: { tenantId: string; variantId: string; inventoryLocationId: string },
  ): Promise<InventoryBalanceResult> {
    return this.getBalance(proof, key);
  }

  private singleKeyResult(
    variantId: string,
    inventoryLocationId: string,
    row: z.infer<typeof SingleKeyResultRowSchema>,
    changed: boolean,
  ): InventoryMutationResult {
    if (row.operation_id === null) {
      // Opening and count adjustment (including a durable no-op) always persist an operation; a null
      // id is a server invariant violation, never a client condition.
      throw new Error("Inventory operation did not return an operation id.");
    }
    return {
      operationId: row.operation_id,
      changed,
      variantId,
      inventoryLocationId,
      previousOnHand: toSafeInteger(row.previous_on_hand),
      newOnHand: toSafeInteger(row.on_hand),
      version: toSafeInteger(row.version),
    };
  }
}

export interface SupabaseInventoryRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseInventoryRepository(
  configuration: SupabaseInventoryRepositoryConfiguration,
): SupabaseInventoryRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseInventoryRepository(client);
}
