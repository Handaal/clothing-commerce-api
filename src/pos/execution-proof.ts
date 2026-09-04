import {
  assertAuthorizedOperationProof,
  AuthorizationError,
  type AuthorizationResource,
  type AuthorizedOperationContext,
} from "../authorization";
import { PosPermission } from "./model";

declare const posSaleExecutionProofBrand: unique symbol;

export interface PosSaleExecutionProof {
  readonly [posSaleExecutionProofBrand]: true;
  readonly proofs: readonly AuthorizedOperationContext[];
  readonly branchId: string;
  readonly inventoryLocationId: string;
}

const issued = new WeakSet<object>();

export function mintPosSaleExecutionProof(input: {
  readonly proofs: readonly AuthorizedOperationContext[];
  readonly branchId: string;
  readonly inventoryLocationId: string;
}): PosSaleExecutionProof {
  for (const proof of input.proofs) assertAuthorizedOperationProof(proof);
  const required = [
    [PosPermission.createOrder, "branch", input.branchId],
    [PosPermission.fulfillOrder, "branch", input.branchId],
    [PosPermission.readOrder, "branch", input.branchId],
    [PosPermission.capturePayment, "branch", input.branchId],
    [PosPermission.issueInventory, "inventory_location", input.inventoryLocationId],
  ] as const;
  for (const [permission, kind, id] of required) {
    const proof = input.proofs.find((candidate) => candidate.permissionKey === permission);
    if (!proof) throw new AuthorizationError("PERMISSION_DENIED");
    const matches = proof.resources.some(
      (resource: AuthorizationResource) => resource.kind === kind && resource.id === id,
    );
    if (!matches) throw new AuthorizationError("SCOPE_DENIED");
  }
  const result = Object.freeze({ ...input }) as unknown as PosSaleExecutionProof;
  issued.add(result);
  return result;
}

export function assertPosSaleExecutionProof(
  value: unknown,
): asserts value is PosSaleExecutionProof {
  if (typeof value !== "object" || value === null || !issued.has(value)) {
    throw new AuthorizationError("AUTHORIZATION_PROOF_INVALID");
  }
}
