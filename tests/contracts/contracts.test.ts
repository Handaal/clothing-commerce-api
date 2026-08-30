import { describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  OrderSummarySchema,
  PageInfoSchema,
  ProductListResponseSchema,
  ProductSummarySchema,
  SafeIntegerSchema,
} from "../../src/contracts";
import { ProductListQuerySchema, queryRecord } from "../../src/management/request";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UUID = "a0000000-0000-4000-8000-000000000001";

describe("serialization primitives", () => {
  it("accepts safe integers and rejects unsafe ones", () => {
    expect(SafeIntegerSchema.safeParse(MAX_SAFE).success).toBe(true);
    expect(SafeIntegerSchema.safeParse(-MAX_SAFE).success).toBe(true);
    expect(SafeIntegerSchema.safeParse(MAX_SAFE + 1).success).toBe(false);
    expect(SafeIntegerSchema.safeParse(1.5).success).toBe(false);
  });

  it("rejects negative money/quantity values", () => {
    expect(NonNegativeIntegerSchema.safeParse(0).success).toBe(true);
    expect(NonNegativeIntegerSchema.safeParse(-1).success).toBe(false);
  });

  it("accepts ISO 8601 UTC times (including sub-second) and rejects offsets/dates", () => {
    expect(IsoDateTimeSchema.safeParse("2026-01-01T00:00:00Z").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-01-01T00:00:00.123456Z").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-01-01T00:00:00+00:00").success).toBe(false);
    expect(IsoDateTimeSchema.safeParse("2026-01-01").success).toBe(false);
  });
});

describe("DTO contracts", () => {
  it("parses a valid product summary and rejects an unsafe total", () => {
    expect(
      ProductSummarySchema.safeParse({
        id: UUID,
        name: "Tee",
        styleCode: null,
        status: "active",
        brandId: UUID,
      }).success,
    ).toBe(true);
  });

  it("rejects an order summary whose total exceeds the safe integer range", () => {
    const order = {
      id: UUID,
      orderNumber: "ORD-1",
      channel: "online",
      status: "placed",
      brandId: UUID,
      branchId: null,
      currency: "USD",
      totalMinor: MAX_SAFE + 1,
      placedAt: "2026-01-01T00:00:00Z",
    };
    expect(OrderSummarySchema.safeParse(order).success).toBe(false);
  });

  it("validates the pagination envelope", () => {
    expect(PageInfoSchema.safeParse({ nextCursor: null, hasMore: false }).success).toBe(true);
    expect(PageInfoSchema.safeParse({ nextCursor: "abc", hasMore: true }).success).toBe(true);
    expect(PageInfoSchema.safeParse({ hasMore: true }).success).toBe(false);
    expect(
      ProductListResponseSchema.safeParse({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }).success,
    ).toBe(true);
  });

  it("validates the frozen error envelope", () => {
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "VALIDATION_ERROR", message: "bad", requestId: UUID },
      }).success,
    ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({
        error: {
          code: "VALIDATION_ERROR",
          message: "bad",
          requestId: UUID,
          details: [{ path: ["limit"], message: "too large" }],
        },
      }).success,
    ).toBe(true);
    // requestId must be a UUID.
    expect(
      ApiErrorSchema.safeParse({ error: { code: "X", message: "y", requestId: "nope" } }).success,
    ).toBe(false);
  });
});

describe("request query validation", () => {
  it("defaults limit to 25 and clamps the range", () => {
    const parsed = ProductListQuerySchema.parse(queryRecord(new URLSearchParams(""), ["limit"]));
    expect(parsed.limit).toBe(25);
    expect(
      ProductListQuerySchema.safeParse(queryRecord(new URLSearchParams("limit=0"), ["limit"]))
        .success,
    ).toBe(false);
    expect(
      ProductListQuerySchema.safeParse(queryRecord(new URLSearchParams("limit=101"), ["limit"]))
        .success,
    ).toBe(false);
    expect(
      ProductListQuerySchema.safeParse(queryRecord(new URLSearchParams("limit=abc"), ["limit"]))
        .success,
    ).toBe(false);
  });

  it("rejects a non-uuid brand filter", () => {
    expect(
      ProductListQuerySchema.safeParse(
        queryRecord(new URLSearchParams("brandId=not-a-uuid"), ["brandId"]),
      ).success,
    ).toBe(false);
  });

  it("treats an empty limit as unset (never zero)", () => {
    const parsed = ProductListQuerySchema.parse(
      queryRecord(new URLSearchParams("limit="), ["limit"]),
    );
    expect(parsed.limit).toBe(25);
  });
});
