import { describe, expect, it } from "vitest";
import { CreateReturnRequestSchema, SettleRefundRequestSchema } from "../../src/contracts";
import { returnDatabaseError } from "../../src/returns/errors";
import { generateOpenApiDocument } from "../../src/openapi/document";

const line = {
  orderLineId: "11111111-1111-4111-8111-111111111111",
  quantity: 1,
  reason: "size",
  disposition: "non_restock",
};
describe("return contract and failure boundary", () => {
  it("defaults to an unsettled refund and never accepts client economics or identity", () => {
    expect(CreateReturnRequestSchema.parse({ lines: [line] })).toMatchObject({
      refundMode: "pending",
      settlementReference: null,
      inventoryLocationId: null,
    });
    for (const input of [
      { amountMinor: 1 },
      { actorMembershipId: line.orderLineId },
      { paymentId: line.orderLineId },
      { status: "succeeded" },
    ])
      expect(CreateReturnRequestSchema.safeParse({ lines: [line], ...input }).success).toBe(false);
  });
  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s", (quantity) => {
    expect(CreateReturnRequestSchema.safeParse({ lines: [{ ...line, quantity }] }).success).toBe(
      false,
    );
  });
  it("rejects absent settlement evidence and unsupported disposition", () => {
    expect(SettleRefundRequestSchema.safeParse({ settlementReference: "  " }).success).toBe(false);
    expect(
      CreateReturnRequestSchema.safeParse({ lines: [{ ...line, disposition: "automatic" }] })
        .success,
    ).toBe(false);
  });
  it("maps only allowlisted database errors without leaking diagnostics", () => {
    expect(returnDatabaseError({ code: "RTQTY", message: "private sql" })).toMatchObject({
      code: "RETURN_QUANTITY_EXCEEDED",
      httpStatus: 409,
    });
    expect(returnDatabaseError({ code: "RT422", message: "PAYMENT_NOT_CAPTURED" })).toMatchObject({
      code: "PAYMENT_NOT_CAPTURED",
    });
    expect(returnDatabaseError({ code: "42501", message: "secret table" }).message).toBe(
      "Unexpected return persistence failure.",
    );
  });
  it("documents explicit authentication and idempotency for both return commands", () => {
    const paths = generateOpenApiDocument().paths;
    for (const post of [
      paths["/api/v1/orders/{orderId}/returns"].post,
      paths["/api/v1/returns/{returnId}/refund"].post,
    ]) {
      expect(post.security).toEqual([{ clerkSessionToken: [] }]);
      expect(post.parameters).toContainEqual({
        $ref: "#/components/parameters/IdempotencyKeyHeader",
      });
      expect(post.parameters).toContainEqual({ $ref: "#/components/parameters/TenantIdHeader" });
    }
  });
});
