import {
  assertAuthorizedOperationProof,
  AuthorizationError,
  type AuthorizationResource,
  type AuthorizedOperationContext,
} from "../authorization";
import { FulfillmentPermission } from "./model";

/**
 * A composite capability proving that BOTH authorities required to WRITE a Fulfillment were satisfied
 * against the exact resources of one Order and one InventoryLocation:
 *
 *   - commercial: a genuine AuthorizedOperationProof for `orders.fulfill` against the persisted Order's
 *     brand (ONLINE) or branch (POS) resource;
 *   - custody:    a genuine AuthorizedOperationProof for `inventory.issue` against the
 *     `inventory_location` resource.
 *
 * A generic AuthorizedOperationProof is NOT sufficient to reach the Fulfillment mutation boundary; the
 * repository requires THIS type. It is minted only by the trusted minting path in this module (used
 * solely by FulfillmentService, which does not re-export the mint from the module's public surface), so
 * ordinary callers cannot fabricate it: they can neither obtain genuine AuthorizedOperationProofs
 * without passing authorization, nor add an object to the module-private provenance set.
 */
declare const fulfillmentExecutionProofBrand: unique symbol;

export interface FulfillmentExecutionProof {
  readonly [fulfillmentExecutionProofBrand]: true;
  readonly commercial: AuthorizedOperationContext;
  readonly custody: AuthorizedOperationContext;
  readonly orderId: string;
  readonly inventoryLocationId: string;
}

// Module-private provenance registry. Nothing outside this module can observe or add to it, so a
// structurally identical object minted elsewhere is rejected by assertFulfillmentExecutionProof.
const issuedFulfillmentExecutionProofs = new WeakSet<object>();

function resourceMatches(
  resources: readonly AuthorizationResource[],
  expected: AuthorizationResource,
): boolean {
  return resources.some(
    (resource) => resource.kind === expected.kind && resource.id === expected.id,
  );
}

/**
 * Mints a FulfillmentExecutionProof from two genuine AuthorizedOperationProofs. It is intentionally NOT
 * re-exported from src/fulfillments/index.ts, so it is reachable only from inside this module (the
 * trusted FulfillmentService path). It fails closed unless:
 *   - both inputs are genuine proofs issued by this process's AuthorizationService;
 *   - the commercial proof carries exactly `orders.fulfill` and covers the expected brand/branch resource;
 *   - the custody proof carries exactly `inventory.issue` and covers the expected inventory_location.
 * A custody-only, commercial-only, mismatched-permission, or wrong-resource combination is rejected.
 */
export function mintFulfillmentExecutionProof(params: {
  readonly commercial: AuthorizedOperationContext;
  readonly custody: AuthorizedOperationContext;
  readonly orderId: string;
  readonly inventoryLocationId: string;
  readonly commercialResource: AuthorizationResource;
}): FulfillmentExecutionProof {
  // Both must be genuine, process-issued authorization proofs (not structurally similar fakes).
  assertAuthorizedOperationProof(params.commercial);
  assertAuthorizedOperationProof(params.custody);

  if (params.commercial.permissionKey !== FulfillmentPermission.fulfill) {
    throw new AuthorizationError("PERMISSION_DENIED");
  }
  if (params.custody.permissionKey !== FulfillmentPermission.issue) {
    throw new AuthorizationError("PERMISSION_DENIED");
  }

  const custodyResource: AuthorizationResource = {
    kind: "inventory_location",
    id: params.inventoryLocationId,
  };

  if (!resourceMatches(params.commercial.resources, params.commercialResource)) {
    throw new AuthorizationError("SCOPE_DENIED");
  }
  if (!resourceMatches(params.custody.resources, custodyResource)) {
    throw new AuthorizationError("SCOPE_DENIED");
  }

  const proof = Object.freeze({
    commercial: params.commercial,
    custody: params.custody,
    orderId: params.orderId,
    inventoryLocationId: params.inventoryLocationId,
  }) as unknown as FulfillmentExecutionProof;
  issuedFulfillmentExecutionProofs.add(proof);
  return proof;
}

/**
 * Rejects any object that was not minted by mintFulfillmentExecutionProof in this process. The
 * Fulfillment repository calls this before the privileged mutation, so an inventory.issue proof alone,
 * a plain read proof, or a forged composite object can never reach the mutation path.
 */
export function assertFulfillmentExecutionProof(
  value: unknown,
): asserts value is FulfillmentExecutionProof {
  if (typeof value !== "object" || value === null || !issuedFulfillmentExecutionProofs.has(value)) {
    throw new AuthorizationError("AUTHORIZATION_PROOF_INVALID");
  }
}
