import { z } from "zod";

import {
  executeAuthorizedOperation,
  type AuthorizationContext,
  type AuthorizationService,
  type AuthorizedOperationContext,
} from "../authorization";
import type {
  AllocateInventoryChannelsResponse,
  ChannelStockMode,
  InitializeInventoryChannelsResponse,
  InventoryChannelBalance,
  InventoryChannelStateResponse,
} from "../contracts/management/inventory-channels";
import { InventoryError } from "./errors";
import { InventoryPermission } from "./model";

/**
 * ADR-042 Website/POS channel stock application service. Reads require inventory.read and changes require
 * inventory.adjust over the target inventory location (the same authority that may recount stock there).
 * Tenant and actor come from the verified context only. The repository talks to the hardened
 * inventory_private functions; this service never touches buckets directly.
 */

export interface ChannelAllocationLineCommand {
  readonly variantId: string;
  readonly websiteQuantity: number;
  readonly posQuantity: number;
  readonly expectedBalanceVersion: number;
  readonly expectedAllocationVersion: number;
}

export interface InventoryChannelRepository {
  getMode(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<ChannelStockMode | null>;
  listBalances(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryChannelBalance[]>;
  /** Returns the allocation run id, or null when the location was already initialized. */
  initialize(
    proof: AuthorizedOperationContext,
    command: { tenantId: string; inventoryLocationId: string; actorMembershipId: string },
  ): Promise<string | null>;
  allocate(
    proof: AuthorizedOperationContext,
    command: {
      tenantId: string;
      inventoryLocationId: string;
      actorMembershipId: string;
      reason: string;
      idempotencyKey: string;
      lines: readonly ChannelAllocationLineCommand[];
    },
  ): Promise<string>;
}

const LocationInputSchema = z.object({ inventoryLocationId: z.string().uuid() }).strict();

const AllocateInputSchema = z
  .object({
    inventoryLocationId: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().trim().min(1).max(200),
    lines: z
      .array(
        z
          .object({
            variantId: z.string().uuid(),
            websiteQuantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            posQuantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            expectedBalanceVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            expectedAllocationVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .refine(
    (value) => new Set(value.lines.map((line) => line.variantId)).size === value.lines.length,
  );

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InventoryError("INVALID_QUANTITY");
  }
  return parsed.data;
}

/**
 * ADR-042 §13 (owner decision 2026-11-14 night): the Website/POS stock split is superseded. The read model
 * stays (every location reports `legacy`), but set-up and allocation are refused with a deterministic
 * error. Kept as a constant so the refusal is unconditional at runtime and greppable.
 */
export const CHANNEL_STOCK_SUPERSEDED = true as const;

export class InventoryChannelService {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly repository: InventoryChannelRepository,
  ) {}

  async getChannelState(
    context: AuthorizationContext,
    input: { inventoryLocationId: string },
  ): Promise<InventoryChannelStateResponse> {
    const command = parse(LocationInputSchema, input);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.read,
        resources: [{ kind: "inventory_location", id: command.inventoryLocationId }],
      },
      operation: (proof) => {
        // ADR-042 §13: the whole channel surface is retired (no live split screen or bucket view).
        if (CHANNEL_STOCK_SUPERSEDED) throw new InventoryError("CHANNEL_STOCK_SUPERSEDED");
        return this.readState(proof, context.tenant.id, command.inventoryLocationId);
      },
    });
  }

  async initializeChannels(
    context: AuthorizationContext,
    input: { inventoryLocationId: string },
  ): Promise<InitializeInventoryChannelsResponse> {
    const command = parse(LocationInputSchema, input);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.adjust,
        resources: [{ kind: "inventory_location", id: command.inventoryLocationId }],
      },
      operation: async (proof) => {
        // ADR-042 §13: stock is one shared pool; channel set-up is retired (fails before any DB write).
        if (CHANNEL_STOCK_SUPERSEDED) throw new InventoryError("CHANNEL_STOCK_SUPERSEDED");
        const runId = await this.repository.initialize(proof, {
          tenantId: context.tenant.id,
          inventoryLocationId: command.inventoryLocationId,
          actorMembershipId: context.membership.id,
        });
        const mode = await this.requireMode(proof, context.tenant.id, command.inventoryLocationId);
        return {
          inventoryLocationId: command.inventoryLocationId,
          mode,
          initialized: runId !== null,
          allocationRunId: runId,
        };
      },
    });
  }

  async allocateChannels(
    context: AuthorizationContext,
    input: {
      inventoryLocationId: string;
      reason: string;
      idempotencyKey: string;
      lines: readonly ChannelAllocationLineCommand[];
    },
  ): Promise<AllocateInventoryChannelsResponse> {
    const command = parse(AllocateInputSchema, input);
    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.adjust,
        resources: [{ kind: "inventory_location", id: command.inventoryLocationId }],
      },
      operation: async (proof) => {
        // ADR-042 §13: no Website/POS split exists; refuse before any DB write.
        if (CHANNEL_STOCK_SUPERSEDED) throw new InventoryError("CHANNEL_STOCK_SUPERSEDED");
        const runId = await this.repository.allocate(proof, {
          tenantId: context.tenant.id,
          inventoryLocationId: command.inventoryLocationId,
          actorMembershipId: context.membership.id,
          reason: command.reason,
          idempotencyKey: command.idempotencyKey,
          lines: command.lines,
        });
        const wanted = new Set(command.lines.map((line) => line.variantId));
        const balances = await this.repository.listBalances(
          proof,
          context.tenant.id,
          command.inventoryLocationId,
        );
        return {
          allocationRunId: runId,
          inventoryLocationId: command.inventoryLocationId,
          items: balances.filter((balance) => wanted.has(balance.variantId)),
        };
      },
    });
  }

  private async readState(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryChannelStateResponse> {
    const mode = await this.requireMode(proof, tenantId, inventoryLocationId);
    const items =
      mode === "legacy"
        ? []
        : await this.repository.listBalances(proof, tenantId, inventoryLocationId);
    return { inventoryLocationId, mode, items };
  }

  private async requireMode(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<ChannelStockMode> {
    const mode = await this.repository.getMode(proof, tenantId, inventoryLocationId);
    if (mode === null) {
      throw new InventoryError("LOCATION_NOT_FOUND");
    }
    return mode;
  }
}
