import { describe, expect, it, vi } from "vitest";

import type { AuthorizationContext, AuthorizationService } from "../../src/authorization";
import {
  DeletePromotionResponseSchema,
  PromotionDetailSchema,
  UpdatePromotionRequestSchema,
} from "../../src/contracts";
import { promotionDatabaseError } from "../../src/promotions/errors";
import type { PromotionsRepository } from "../../src/promotions/repository";
import { PromotionsService } from "../../src/promotions/service";

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const PROMOTION = "11111111-1111-4111-8111-111111111111";

describe("full promotion edit contract (owner decision 2026-11-18)", () => {
  it("accepts every setting, including targets and a discount-type switch", () => {
    expect(
      UpdatePromotionRequestSchema.safeParse({
        benefitType: "fixed_amount",
        benefitAmountMinor: 500,
        benefitCurrency: "EGP",
        globalRedemptionLimit: 10,
        activationType: "code",
        targetType: "variant_scope",
        targets: [{ productId: PRODUCT, variantId: null }],
      }).success,
    ).toBe(true);
  });

  it("rejects an incomplete discount-type switch and an empty product scope", () => {
    expect(UpdatePromotionRequestSchema.safeParse({ benefitType: "fixed_amount" }).success).toBe(
      false,
    );
    expect(
      UpdatePromotionRequestSchema.safeParse({ benefitType: "buy_x_get_y", buyQuantity: 2 })
        .success,
    ).toBe(false);
    expect(
      UpdatePromotionRequestSchema.safeParse({ targetType: "variant_scope", targets: [] }).success,
    ).toBe(false);
  });

  it("parses target display names and still accepts targets without them", () => {
    const base = {
      id: PROMOTION,
      name: "P",
      status: "active",
      benefitType: "percentage",
      targetType: "variant_scope",
      activationType: "automatic",
      channel: null,
      redemptionCount: 0,
      globalRedemptionLimit: null,
      economicsLocked: false,
      createdAt: "2026-11-18T00:00:00.000Z",
      description: null,
      benefitPercentBp: 1000,
      benefitAmountMinor: null,
      benefitCurrency: null,
      minSubtotalMinor: null,
      maxDiscountMinor: null,
      startsAt: null,
      endsAt: null,
      brandId: null,
      branchId: null,
      remainingRedemptions: null,
      codes: [],
    };
    const named = PromotionDetailSchema.parse({
      ...base,
      targets: [{ productId: PRODUCT, variantId: null, productName: "Tee", variantName: null }],
    });
    expect(named.targets[0]?.productName).toBe("Tee");
    expect(
      PromotionDetailSchema.safeParse({
        ...base,
        targets: [{ productId: PRODUCT, variantId: null }],
      }).success,
    ).toBe(true);
  });

  it("describes the delete outcome", () => {
    expect(
      DeletePromotionResponseSchema.parse({ promotionId: PROMOTION, outcome: "archived" }).outcome,
    ).toBe("archived");
    expect(
      DeletePromotionResponseSchema.safeParse({ promotionId: PROMOTION, outcome: "gone" }).success,
    ).toBe(false);
  });
});

describe("PromotionsService.remove", () => {
  it("requires promotions.manage and delegates to the repository", async () => {
    const authorize = vi.fn().mockResolvedValue({ proof: true });
    const remove = vi.fn().mockResolvedValue({ promotionId: PROMOTION, outcome: "deleted" });
    const service = new PromotionsService(
      { authorize } as unknown as AuthorizationService,
      { remove } as unknown as PromotionsRepository,
    );
    const context = {} as AuthorizationContext;
    await expect(service.remove(context, PROMOTION)).resolves.toEqual({
      promotionId: PROMOTION,
      outcome: "deleted",
    });
    expect(authorize).toHaveBeenCalledWith(context, { permissionKey: "promotions.manage" });
    expect(remove).toHaveBeenCalledWith({ proof: true }, PROMOTION);
  });

  it("rejects a malformed id before touching the repository", async () => {
    const remove = vi.fn();
    const service = new PromotionsService(
      { authorize: vi.fn().mockResolvedValue({}) } as unknown as AuthorizationService,
      { remove } as unknown as PromotionsRepository,
    );
    await expect(service.remove({} as AuthorizationContext, "nope")).rejects.toMatchObject({
      code: "INVALID_PROMOTION",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("maps the database's not-found and below-use errors", () => {
    expect(promotionDatabaseError({ code: "PR404" })).toMatchObject({
      code: "PROMOTION_NOT_FOUND",
    });
    expect(promotionDatabaseError({ code: "PR422" })).toMatchObject({
      code: "PROMOTION_LIMIT_BELOW_USE",
    });
  });
});
