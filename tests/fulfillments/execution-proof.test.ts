import { describe, expect, it } from "vitest";

import {
  AuthorizationService,
  assertAuthorizedOperationProof,
  type AuthorizedOperationContext,
} from "../../src/authorization";
import {
  assertFulfillmentExecutionProof,
  mintFulfillmentExecutionProof,
} from "../../src/fulfillments/execution-proof";
import { FulfillmentPermission } from "../../src/fulfillments";
import {
  brand,
  contextWith,
  defaultResourceTenantMap,
  grant,
  ids,
  location,
  StubResourceRepository,
} from "./fakes";

const authService = new AuthorizationService(
  new StubResourceRepository(defaultResourceTenantMap()),
);

const context = contextWith([
  grant([FulfillmentPermission.fulfill], [brand(ids.brand)]),
  grant([FulfillmentPermission.issue], [location(ids.location)]),
  grant([FulfillmentPermission.read], [brand(ids.brand)]),
]);

function commercialProof(): Promise<AuthorizedOperationContext> {
  return authService.authorize(context, {
    permissionKey: FulfillmentPermission.fulfill,
    resources: [brand(ids.brand)],
  });
}
function custodyProof(): Promise<AuthorizedOperationContext> {
  return authService.authorize(context, {
    permissionKey: FulfillmentPermission.issue,
    resources: [location(ids.location)],
  });
}
function readProof(): Promise<AuthorizedOperationContext> {
  return authService.authorize(context, {
    permissionKey: FulfillmentPermission.read,
    resources: [brand(ids.brand)],
  });
}

/** Synchronously asserts a thunk throws an AuthorizationError with the given code. */
function expectAuthorizationError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  expect(() => {
    try {
      fn();
    } catch (error) {
      thrown = error;
      throw error;
    }
  }).toThrowError();
  expect(thrown).toMatchObject({ name: "AuthorizationError", code });
}

describe("FulfillmentExecutionProof provenance", () => {
  it("mints from a genuine commercial + custody pair and passes the provenance assertion", async () => {
    const proof = mintFulfillmentExecutionProof({
      commercial: await commercialProof(),
      custody: await custodyProof(),
      orderId: ids.orderOnline,
      inventoryLocationId: ids.location,
      commercialResource: brand(ids.brand),
    });
    expect(() => assertFulfillmentExecutionProof(proof)).not.toThrow();
    expect(proof.orderId).toBe(ids.orderOnline);
    expect(proof.inventoryLocationId).toBe(ids.location);
  });

  it("rejects a custody proof supplied where the commercial authority is required", async () => {
    const custody = await custodyProof();
    expectAuthorizationError(
      () =>
        mintFulfillmentExecutionProof({
          commercial: custody,
          custody,
          orderId: ids.orderOnline,
          inventoryLocationId: ids.location,
          commercialResource: brand(ids.brand),
        }),
      "PERMISSION_DENIED",
    );
  });

  it("rejects a commercial proof supplied where the custody authority is required", async () => {
    const commercial = await commercialProof();
    expectAuthorizationError(
      () =>
        mintFulfillmentExecutionProof({
          commercial,
          custody: commercial,
          orderId: ids.orderOnline,
          inventoryLocationId: ids.location,
          commercialResource: brand(ids.brand),
        }),
      "PERMISSION_DENIED",
    );
  });

  it("rejects an unrelated (read) proof as the commercial authority", async () => {
    const read = await readProof();
    const custody = await custodyProof();
    expectAuthorizationError(
      () =>
        mintFulfillmentExecutionProof({
          commercial: read,
          custody,
          orderId: ids.orderOnline,
          inventoryLocationId: ids.location,
          commercialResource: brand(ids.brand),
        }),
      "PERMISSION_DENIED",
    );
  });

  it("rejects a custody proof for a different location than the fulfillment", async () => {
    const commercial = await commercialProof();
    const custody = await custodyProof();
    expectAuthorizationError(
      () =>
        mintFulfillmentExecutionProof({
          commercial,
          custody,
          orderId: ids.orderOnline,
          inventoryLocationId: ids.locationOther,
          commercialResource: brand(ids.brand),
        }),
      "SCOPE_DENIED",
    );
  });

  it("rejects a commercial proof that does not cover the expected resource", async () => {
    const commercial = await commercialProof();
    const custody = await custodyProof();
    expectAuthorizationError(
      () =>
        mintFulfillmentExecutionProof({
          commercial,
          custody,
          orderId: ids.orderOnline,
          inventoryLocationId: ids.location,
          commercialResource: brand(ids.orderPos),
        }),
      "SCOPE_DENIED",
    );
  });

  it("rejects a forged composite object that was never minted", () => {
    const forged = {
      commercial: {},
      custody: {},
      orderId: ids.orderOnline,
      inventoryLocationId: ids.location,
    };
    expectAuthorizationError(
      () => assertFulfillmentExecutionProof(forged),
      "AUTHORIZATION_PROOF_INVALID",
    );
  });

  it("does not accept a plain read proof at the mutation provenance boundary", async () => {
    const proof = await readProof();
    expectAuthorizationError(
      () => assertFulfillmentExecutionProof(proof),
      "AUTHORIZATION_PROOF_INVALID",
    );
  });

  it("does not accept the composite mutation proof as a plain authorization proof", async () => {
    const proof = mintFulfillmentExecutionProof({
      commercial: await commercialProof(),
      custody: await custodyProof(),
      orderId: ids.orderOnline,
      inventoryLocationId: ids.location,
      commercialResource: brand(ids.brand),
    });
    // The composite proof is a distinct object; it is NOT a genuine AuthorizedOperationProof.
    expect(() => assertAuthorizedOperationProof(proof)).toThrowError();
  });
});
