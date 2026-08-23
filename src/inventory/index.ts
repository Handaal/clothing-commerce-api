export { InventoryService } from "./inventory-service";
export {
  InventoryError,
  inventoryErrorCodes,
  inventoryErrorResponse,
  type InventoryErrorCode,
} from "./errors";
export {
  InventoryPermission,
  type AdjustInventoryInput,
  type GetInventoryBalanceInput,
  type InventoryBalanceResult,
  type InventoryMutationResult,
  type InventoryObservedMutationResult,
  type InventoryTransferResult,
  type InventoryTransferSide,
  type IssueInventoryInput,
  type ReceiveInventoryInput,
  type SetOpeningStockInput,
  type TransferInventoryInput,
} from "./model";
export {
  createSupabaseInventoryRepository,
  SupabaseInventoryRepository,
  type SupabaseInventoryRepositoryConfiguration,
} from "./supabase-inventory-repository";
export type { InventoryRepository } from "./repository";
