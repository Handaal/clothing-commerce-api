import { z } from "zod";

import {
  executeAuthorizedOperation,
  type AuthorizationContext,
  type AuthorizationResource,
  type AuthorizationService,
  type AuthorizedOperationContext,
} from "../authorization";
import { InventoryError } from "./errors";
import {
  AdjustInventoryInputSchema,
  GetInventoryBalanceInputSchema,
  InventoryPermission,
  IssueInventoryInputSchema,
  ReceiveInventoryInputSchema,
  SetOpeningStockInputSchema,
  TransferInventoryInputSchema,
  type AdjustInventoryInput,
  type GetInventoryBalanceInput,
  type InventoryBalanceResult,
  type InventoryLocationState,
  type InventoryMutationResult,
  type InventoryObservedMutationResult,
  type InventoryTransferResult,
  type IssueInventoryInput,
  type ReceiveInventoryInput,
  type SetOpeningStockInput,
  type TransferInventoryInput,
  type VariantState,
} from "./model";
import type { InventoryRepository } from "./repository";

function locationResource(id: string): AuthorizationResource {
  return { kind: "inventory_location", id };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  // Malformed input at this internal boundary (bad UUID, out-of-range or non-positive quantity,
  // unknown field) surfaces as a single stable, non-leaking error. A future HTTP layer performs
  // richer request-shape validation before reaching the service.
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InventoryError("INVALID_QUANTITY");
  }
  return parsed.data;
}

/**
 * Phase 2C inventory application service. It is the only place the rest of the commerce system
 * expresses stock intent. Every command authorizes a permission against the target InventoryLocation
 * resource(s) via the Phase 1D authorization service before any privileged database access, derives
 * the actor Membership from the verified context, validates lifecycle/capability rules, and delegates
 * the ledger write to the inventory repository. No raw ledger detail is ever exposed to callers.
 */
export class InventoryService {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly repository: InventoryRepository,
  ) {}

  async getInventoryBalance(
    context: AuthorizationContext,
    input: GetInventoryBalanceInput,
  ): Promise<InventoryBalanceResult> {
    const command = parseInput(GetInventoryBalanceInputSchema, input);

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.read,
        resources: [locationResource(command.inventoryLocationId)],
      },
      // Reads are permitted regardless of variant/location lifecycle; a key with no history reads as
      // on-hand 0. Authorization has already proven tenant ownership of the target location.
      operation: (proof) =>
        this.repository.getBalance(proof, {
          tenantId: context.tenant.id,
          variantId: command.variantId,
          inventoryLocationId: command.inventoryLocationId,
        }),
    });
  }

  async setOpeningStock(
    context: AuthorizationContext,
    input: SetOpeningStockInput,
  ): Promise<InventoryMutationResult> {
    const command = parseInput(SetOpeningStockInputSchema, input);

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.adjust,
        resources: [locationResource(command.inventoryLocationId)],
      },
      operation: async (proof) => {
        await this.requireActiveVariant(proof, context.tenant.id, command.variantId);
        await this.requireLocationForEntry(proof, context.tenant.id, command.inventoryLocationId);

        return this.repository.recordOpening(proof, {
          tenantId: context.tenant.id,
          variantId: command.variantId,
          inventoryLocationId: command.inventoryLocationId,
          quantity: command.quantity,
          actorMembershipId: context.membership.id,
          idempotencyKey: command.idempotencyKey,
          note: command.note,
        });
      },
    });
  }

  async adjustInventory(
    context: AuthorizationContext,
    input: AdjustInventoryInput,
  ): Promise<InventoryMutationResult> {
    const command = parseInput(AdjustInventoryInputSchema, input);

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.adjust,
        resources: [locationResource(command.inventoryLocationId)],
      },
      operation: async (proof) => {
        await this.requireActiveVariant(proof, context.tenant.id, command.variantId);
        // Reconciliation is allowed on an inactive location; archived is denied.
        await this.requireLocationNotArchived(
          proof,
          context.tenant.id,
          command.inventoryLocationId,
        );

        return this.repository.recordCountAdjustment(proof, {
          tenantId: context.tenant.id,
          variantId: command.variantId,
          inventoryLocationId: command.inventoryLocationId,
          countedQuantity: command.countedQuantity,
          expectedVersion: command.expectedVersion,
          actorMembershipId: context.membership.id,
          idempotencyKey: command.idempotencyKey,
          note: command.note,
        });
      },
    });
  }

  async receiveInventory(
    context: AuthorizationContext,
    input: ReceiveInventoryInput,
  ): Promise<InventoryObservedMutationResult> {
    const command = parseInput(ReceiveInventoryInputSchema, input);

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.receive,
        resources: [locationResource(command.inventoryLocationId)],
      },
      operation: async (proof) => {
        await this.requireActiveVariant(proof, context.tenant.id, command.variantId);
        const location = await this.requireLocationForEntry(
          proof,
          context.tenant.id,
          command.inventoryLocationId,
        );
        if (!location.isReceivingEnabled) {
          throw new InventoryError("LOCATION_CAPABILITY_DENIED");
        }

        return this.repository.recordReceipt(proof, {
          tenantId: context.tenant.id,
          variantId: command.variantId,
          inventoryLocationId: command.inventoryLocationId,
          quantity: command.quantity,
          actorMembershipId: context.membership.id,
          idempotencyKey: command.idempotencyKey,
          note: command.note,
        });
      },
    });
  }

  async issueInventory(
    context: AuthorizationContext,
    input: IssueInventoryInput,
  ): Promise<InventoryObservedMutationResult> {
    const command = parseInput(IssueInventoryInputSchema, input);

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.issue,
        resources: [locationResource(command.inventoryLocationId)],
      },
      operation: async (proof) => {
        // A draft variant is denied; an archived variant may be issued to write off remaining stock.
        await this.requireIssuableVariant(proof, context.tenant.id, command.variantId);
        // Issuing out of an inactive location is allowed (evacuation); archived is denied.
        await this.requireLocationNotArchived(
          proof,
          context.tenant.id,
          command.inventoryLocationId,
        );

        return this.repository.recordIssue(proof, {
          tenantId: context.tenant.id,
          variantId: command.variantId,
          inventoryLocationId: command.inventoryLocationId,
          quantity: command.quantity,
          actorMembershipId: context.membership.id,
          idempotencyKey: command.idempotencyKey,
          note: command.note,
        });
      },
    });
  }

  async transferInventory(
    context: AuthorizationContext,
    input: TransferInventoryInput,
  ): Promise<InventoryTransferResult> {
    const command = parseInput(TransferInventoryInputSchema, input);

    if (command.sourceInventoryLocationId === command.destinationInventoryLocationId) {
      throw new InventoryError("SAME_TRANSFER_LOCATION");
    }

    return executeAuthorizedOperation({
      authorizationService: this.authorizationService,
      context,
      request: {
        permissionKey: InventoryPermission.transfer,
        // Both locations are protected resources; the authorization service proves permission-coupled
        // coverage of each before the operation runs.
        resources: [
          locationResource(command.sourceInventoryLocationId),
          locationResource(command.destinationInventoryLocationId),
        ],
      },
      operation: async (proof) => {
        await this.requireActiveVariant(proof, context.tenant.id, command.variantId);

        const source = await this.requireLocation(
          proof,
          context.tenant.id,
          command.sourceInventoryLocationId,
        );
        // Transfer-out is permitted from an inactive location for evacuation; archived is denied.
        if (source.status === "archived") {
          throw new InventoryError("LOCATION_INACTIVE");
        }
        if (!source.isTransferOriginEnabled) {
          throw new InventoryError("LOCATION_CAPABILITY_DENIED");
        }

        const destination = await this.requireLocationForEntry(
          proof,
          context.tenant.id,
          command.destinationInventoryLocationId,
        );
        if (!destination.isTransferDestinationEnabled) {
          throw new InventoryError("LOCATION_CAPABILITY_DENIED");
        }

        return this.repository.recordTransfer(proof, {
          tenantId: context.tenant.id,
          variantId: command.variantId,
          sourceInventoryLocationId: command.sourceInventoryLocationId,
          destinationInventoryLocationId: command.destinationInventoryLocationId,
          quantity: command.quantity,
          actorMembershipId: context.membership.id,
          idempotencyKey: command.idempotencyKey,
          note: command.note,
        });
      },
    });
  }

  private async requireActiveVariant(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
  ): Promise<VariantState> {
    const variant = await this.repository.getVariantState(proof, tenantId, variantId);
    if (variant === null) {
      throw new InventoryError("VARIANT_NOT_FOUND");
    }
    if (variant.status !== "active") {
      throw new InventoryError("VARIANT_INACTIVE");
    }
    return variant;
  }

  private async requireIssuableVariant(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
  ): Promise<VariantState> {
    const variant = await this.repository.getVariantState(proof, tenantId, variantId);
    if (variant === null) {
      throw new InventoryError("VARIANT_NOT_FOUND");
    }
    if (variant.status === "draft") {
      throw new InventoryError("VARIANT_INACTIVE");
    }
    return variant;
  }

  private async requireLocation(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryLocationState> {
    const location = await this.repository.getLocationState(proof, tenantId, inventoryLocationId);
    if (location === null) {
      throw new InventoryError("LOCATION_NOT_FOUND");
    }
    return location;
  }

  private async requireLocationForEntry(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryLocationState> {
    const location = await this.requireLocation(proof, tenantId, inventoryLocationId);
    if (location.status !== "active") {
      throw new InventoryError("LOCATION_INACTIVE");
    }
    return location;
  }

  private async requireLocationNotArchived(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryLocationState> {
    const location = await this.requireLocation(proof, tenantId, inventoryLocationId);
    if (location.status === "archived") {
      throw new InventoryError("LOCATION_INACTIVE");
    }
    return location;
  }
}
