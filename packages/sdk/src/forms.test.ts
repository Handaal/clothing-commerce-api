import { describe, expect, it } from "vitest";

import type { PromotionDetail } from "../../../src/contracts/management/promotions";
import type { Sale } from "../../../src/contracts/management/sales";
import {
  buildContentRequest,
  buildCreatePromotionRequest,
  buildCreateSaleRequest,
  buildUpdatePromotionRequest,
  emptyPromotionForm,
  emptySaleForm,
  formatMinorInput,
  formatPercentBasisPoints,
  moveSelection,
  normalizePromotionCode,
  parseMoneyInput,
  parsePercentInput,
  parsePositiveIntegerInput,
  previewSalePrice,
  promotionCodeLimit,
  promotionEffectiveState,
  promotionTargetLabel,
  promotionToForm,
  saleLiveState,
  saleToForm,
  validateContentForm,
  validatePromotionForm,
  validateSaleForm,
  type PromotionFormState,
  type StorefrontContentForm,
} from "./forms";

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const VARIANT = "66666666-6666-4666-8666-666666666666";

function detail(overrides: Partial<PromotionDetail> = {}): PromotionDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Weekend",
    status: "active",
    benefitType: "percentage",
    targetType: "order",
    activationType: "automatic",
    channel: null,
    redemptionCount: 3,
    globalRedemptionLimit: null,
    economicsLocked: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    description: null,
    benefitPercentBp: 1000,
    benefitAmountMinor: null,
    benefitCurrency: null,
    buyQuantity: null,
    getQuantity: null,
    minSubtotalMinor: null,
    maxDiscountMinor: null,
    startsAt: null,
    endsAt: null,
    brandId: null,
    branchId: null,
    remainingRedemptions: null,
    targets: [],
    codes: [],
    ...overrides,
  };
}

const promo = (overrides: Partial<PromotionFormState> = {}): PromotionFormState => ({
  ...emptyPromotionForm(),
  name: "Weekend",
  benefitValue: "10",
  ...overrides,
});

describe("parsers", () => {
  it("parses percentages, money and whole numbers exactly", () => {
    expect(parsePercentInput("12.5")).toBe(1250);
    expect(parsePercentInput("0")).toEqual({ code: "percent_range" });
    expect(parsePercentInput("100.01")).toEqual({ code: "percent_range" });
    expect(parseMoneyInput("25.5")).toBe(2550);
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("0", true)).toBe(0);
    expect(parseMoneyInput("0")).toEqual({ code: "amount_positive" });
    expect(parseMoneyInput("1.234")).toEqual({ code: "amount_format" });
    expect(parsePositiveIntegerInput("4")).toBe(4);
    expect(parsePositiveIntegerInput("x")).toEqual({ code: "whole_number" });
    expect(parsePositiveIntegerInput("0")).toEqual({ code: "positive" });
    expect(formatMinorInput(2550)).toBe("25.50");
    expect(formatMinorInput(5)).toBe("0.05");
    expect(formatPercentBasisPoints(1250)).toBe("12.5%");
  });
});

describe("promotion form", () => {
  it("normalises codes and limits", () => {
    expect(normalizePromotionCode(" welcome10 ")).toBe("WELCOME10");
    expect(normalizePromotionCode("")).toEqual({ code: "required" });
    expect(normalizePromotionCode("BAD CODE")).toEqual({ code: "code_format" });
    expect(promotionCodeLimit("single", "")).toBe(1);
    expect(promotionCodeLimit("custom", "")).toEqual({ code: "whole_number" });
  });

  it("validates create input", () => {
    expect(validatePromotionForm(promo(), "create")).toEqual({});
    const issues = validatePromotionForm(
      promo({
        name: "",
        benefitValue: "120",
        targetType: "variant_scope",
        activationType: "code",
        globalLimit: "0",
        startsAt: "2026-12-02T10:00",
        endsAt: "2026-12-01T10:00",
      }),
      "create",
    );
    expect(issues).toMatchObject({
      name: { code: "required" },
      benefitValue: { code: "percent_range" },
      targets: { code: "required" },
      initialCode: { code: "required" },
      globalLimit: { code: "positive" },
      endsAt: { code: "end_before_start" },
    });
  });

  it("only requires a code on edit when asked", () => {
    const state = promo({ activationType: "code" });
    expect(validatePromotionForm(state, "edit").initialCode).toBeUndefined();
    expect(validatePromotionForm(state, "edit", { requireInitialCode: true }).initialCode).toEqual({
      code: "required",
    });
  });

  it("builds a create request with targets, code and channel", () => {
    expect(
      buildCreatePromotionRequest(
        promo({
          benefitType: "fixed_amount",
          benefitValue: "50",
          targetType: "variant_scope",
          targets: [
            { target: { productId: PRODUCT, variantId: null }, label: "Shirt" },
            { target: { productId: null, variantId: VARIANT }, label: "Shirt · M" },
          ],
          activationType: "code",
          initialCode: "save50",
          codeLimitKind: "custom",
          codeCustomLimit: "3",
          channel: "pos",
        }),
      ),
    ).toMatchObject({
      benefitType: "fixed_amount",
      benefitAmountMinor: 5000,
      benefitCurrency: "EGP",
      targets: [
        { productId: PRODUCT, variantId: null },
        { productId: null, variantId: VARIANT },
      ],
      codes: [{ code: "SAVE50", maxRedemptions: 3 }],
      channel: "pos",
    });
    expect(
      buildCreatePromotionRequest(promo({ benefitType: "buy_x_get_y", channel: "pos" })),
    ).toMatchObject({
      benefitType: "buy_x_get_y",
      buyQuantity: 2,
      getQuantity: 1,
      channel: "online",
    });
  });

  it("edits every setting of a redeemed promotion, sending only what changed", () => {
    const current = detail();
    const state = promotionToForm(current);
    expect(buildUpdatePromotionRequest(state, current)).toEqual({
      name: "Weekend",
      description: null,
      startsAt: null,
      endsAt: null,
    });
    const edited: PromotionFormState = {
      ...state,
      benefitType: "fixed_amount",
      benefitValue: "30",
      globalLimit: "100",
      targetType: "variant_scope",
      targets: [{ target: { productId: PRODUCT, variantId: null }, label: "Shirt" }],
      activationType: "code",
    };
    expect(buildUpdatePromotionRequest(edited, current)).toMatchObject({
      benefitType: "fixed_amount",
      benefitAmountMinor: 3000,
      benefitCurrency: "EGP",
      globalRedemptionLimit: 100,
      targetType: "variant_scope",
      targets: [{ productId: PRODUCT, variantId: null }],
      activationType: "code",
    });
  });

  it("resends targets only when the selection changed", () => {
    const current = detail({
      targetType: "variant_scope",
      targets: [{ productId: PRODUCT, variantId: null, productName: "Shirt" }],
    });
    const state = promotionToForm(current);
    expect(state.targets).toEqual([
      { target: { productId: PRODUCT, variantId: null }, label: "Shirt" },
    ]);
    expect(buildUpdatePromotionRequest(state, current).targets).toBeUndefined();
    const added = {
      ...state,
      targets: [
        ...state.targets,
        { target: { productId: null, variantId: VARIANT }, label: "Tee · M" },
      ],
    };
    expect(buildUpdatePromotionRequest(added, current).targets).toHaveLength(2);
  });

  it("labels targets from their resolved names", () => {
    expect(
      promotionTargetLabel({ productId: PRODUCT, variantId: null, productName: "Shirt" }),
    ).toBe("Shirt");
    expect(
      promotionTargetLabel({
        productId: null,
        variantId: VARIANT,
        productName: "Shirt",
        variantName: null,
        sku: "SH-M",
      }),
    ).toBe("Shirt · SH-M");
  });

  it("derives the live state", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    expect(promotionEffectiveState(detail({ status: "inactive" }), now)).toBe("inactive");
    expect(promotionEffectiveState(detail({ startsAt: "2026-12-01T00:00:00.000Z" }), now)).toBe(
      "scheduled",
    );
    expect(promotionEffectiveState(detail({ endsAt: "2026-11-01T00:00:00.000Z" }), now)).toBe(
      "expired",
    );
    expect(promotionEffectiveState(detail({ remainingRedemptions: 0 }), now)).toBe("exhausted");
  });
});

describe("sale form", () => {
  const sale = {
    id: "s1",
    name: "Summer",
    status: "active",
    benefitType: "fixed_amount",
    benefitPercentBp: null,
    benefitAmountMinor: 10000,
    benefitCurrency: "EGP",
    scope: "products",
    collectionId: null,
    productIds: [PRODUCT],
    startsAt: null,
    endsAt: "2026-12-01T00:00:00.000Z",
  } as unknown as Sale;

  it("validates, builds and round-trips", () => {
    expect(validateSaleForm({ ...emptySaleForm(), scope: "products" })).toMatchObject({
      name: { code: "required" },
      value: { code: "percent_range" },
      productIds: { code: "required" },
    });
    const state = saleToForm(sale, { toDateInput: (iso) => (iso ? "LOCAL" : "") });
    expect(state).toMatchObject({ value: "100.00", endsAt: "LOCAL", productIds: [PRODUCT] });
    expect(buildCreateSaleRequest({ ...emptySaleForm(), name: "X", value: "25" })).toMatchObject({
      benefitType: "percentage",
      benefitPercentBp: 2500,
      scope: "all",
      status: "active",
    });
    expect(previewSalePrice({ ...emptySaleForm(), value: "10" }, 69_000)).toBe(62_100);
    expect(saleLiveState(sale, new Date("2026-12-02T00:00:00.000Z"))).toBe("ended");
  });
});

describe("storefront content form", () => {
  const form: StorefrontContentForm = {
    eyebrow: "",
    title: "Hello",
    subtitle: "",
    ctaLabel: "Shop",
    ctaHref: "",
    image: null,
    imageAlt: "",
    featuredHeading: "",
    featuredProductIds: Array.from({ length: 25 }, (_, i) => `p${i}`),
    featuredCollectionIds: [],
  };

  it("validates links, lengths and featured limits", () => {
    expect(validateContentForm(form)).toMatchObject({
      ctaHref: { code: "link_required" },
      featuredProductIds: { code: "too_many", max: 24 },
    });
    expect(validateContentForm({ ...form, ctaHref: "javascript:x" }).ctaHref).toEqual({
      code: "unsafe_link",
    });
    expect(validateContentForm({ ...form, title: "x".repeat(161) }).title).toEqual({
      code: "too_long",
      max: 160,
    });
    expect(buildContentRequest({ ...form, ctaHref: "/catalog" }).hero.ctaHref).toBe("/catalog");
    expect(moveSelection(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });
});
