import type { AuthorizedOperationContext } from "../authorization";
import type {
  InventoryBalanceResult,
  InventoryLocationState,
  InventoryMutationResult,
  InventoryObservedMutationResult,
  InventoryTransferResult,
  StockKey,
  VariantState,
} from "./model";

/**
 * Internal, authorized command shapes passed from the inventory service to the repository. tenantId
 * and actorMembershipId are already derived from the verified authorization context; the repository
 * never accepts caller-controlled tenant or actor identity.
 */
export interface RecordOpeningCommand extends StockKey {
  readonly quantity: number;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export interface RecordCountAdjustmentCommand extends StockKey {
  readonly countedQuantity: number;
  readonly expectedVersion: number;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export interface RecordReceiptCommand extends StockKey {
  readonly supplierId?: string;
  readonly supplierReference?: string;
  readonly quantity: number;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export interface RecordIssueCommand extends StockKey {
  readonly quantity: number;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export interface RecordTransferCommand {
  readonly tenantId: string;
  readonly variantId: string;
  readonly sourceInventoryLocationId: string;
  readonly destinationInventoryLocationId: string;
  readonly quantity: number;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly note?: string;
}

/**
 * Narrow, inventory-module-internal port that hides every Phase 2B/2C ledger detail. It never exposes
 * a generic record_operation, a raw client, SQL, movement JSON, signed deltas, or an RPC name.
 * Application services outside this module never receive this repository. Every method requires the
 * opaque authorization proof so no privileged database access can occur before authorization.
 */
export interface InventoryRepository {
  getBalance(proof: AuthorizedOperationContext, key: StockKey): Promise<InventoryBalanceResult>;
  getVariantState(
    proof: AuthorizedOperationContext,
    tenantId: string,
    variantId: string,
  ): Promise<VariantState | null>;
  getLocationState(
    proof: AuthorizedOperationContext,
    tenantId: string,
    inventoryLocationId: string,
  ): Promise<InventoryLocationState | null>;

  recordOpening(
    proof: AuthorizedOperationContext,
    command: RecordOpeningCommand,
  ): Promise<InventoryMutationResult>;
  recordCountAdjustment(
    proof: AuthorizedOperationContext,
    command: RecordCountAdjustmentCommand,
  ): Promise<InventoryMutationResult>;
  recordReceipt(
    proof: AuthorizedOperationContext,
    command: RecordReceiptCommand,
  ): Promise<InventoryObservedMutationResult>;
  recordIssue(
    proof: AuthorizedOperationContext,
    command: RecordIssueCommand,
  ): Promise<InventoryObservedMutationResult>;
  recordTransfer(
    proof: AuthorizedOperationContext,
    command: RecordTransferCommand,
  ): Promise<InventoryTransferResult>;
}
