import { describe, expect, it } from "vitest";

import {
  InvalidCursorError,
  decodeInventoryCursor,
  decodeOrderCursor,
  decodeProductCursor,
  encodeInventoryCursor,
  encodeOrderCursor,
  encodeProductCursor,
} from "../../src/management/cursor";

const UUID_A = "a0000000-0000-4000-8000-000000000001";
const UUID_B = "b0000000-0000-4000-8000-000000000002";

describe("cursor codec", () => {
  it("round-trips a product cursor", () => {
    const key = { createdAt: "2026-01-01T00:00:00.000Z", id: UUID_A };
    expect(decodeProductCursor(encodeProductCursor(key))).toEqual(key);
  });

  it("round-trips an inventory cursor", () => {
    const key = { inventoryLocationId: UUID_A, variantId: UUID_B };
    expect(decodeInventoryCursor(encodeInventoryCursor(key))).toEqual(key);
  });

  it("round-trips an order cursor", () => {
    const key = { placedAt: "2026-02-01T12:34:56.000Z", id: UUID_A };
    expect(decodeOrderCursor(encodeOrderCursor(key))).toEqual(key);
  });

  it("rejects a malformed (non-base64/non-JSON) cursor", () => {
    expect(() => decodeProductCursor("!!!not-valid!!!")).toThrow(InvalidCursorError);
  });

  it("rejects a cursor whose sort discriminator is for a different resource", () => {
    const orderCursor = encodeOrderCursor({ placedAt: "2026-02-01T00:00:00.000Z", id: UUID_A });
    expect(() => decodeProductCursor(orderCursor)).toThrow(InvalidCursorError);
  });

  it("rejects a cursor with the wrong version", () => {
    const forged = Buffer.from(
      JSON.stringify({
        v: 2,
        sort: "created_at_desc",
        k: { createdAt: "2026-01-01T00:00:00.000Z", id: UUID_A },
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeProductCursor(forged)).toThrow(InvalidCursorError);
  });

  it("rejects a cursor with missing/invalid keyset keys", () => {
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        sort: "created_at_desc",
        k: { createdAt: "2026-01-01T00:00:00.000Z" },
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeProductCursor(forged)).toThrow(InvalidCursorError);
  });
});
