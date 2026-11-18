import { describe, expect, it, vi } from "vitest";

import type { AuthorizationContext, AuthorizationService } from "../../src/authorization";
import { shapePublicProduct } from "../../src/catalog/public-product-shape";
import {
  CreateSaleRequestSchema,
  CreatePromotionRequestSchema,
  UpdateStorefrontContentRequestSchema,
} from "../../src/contracts";
import { MerchandisingError, merchandisingDatabaseError } from "../../src/merchandising/errors";
import type { MerchandisingRepository } from "../../src/merchandising/repository";
import { MerchandisingService } from "../../src/merchandising/service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const context = { tenant: { id: TENANT } } as unknown as AuthorizationContext;

function service(overrides: Partial<MerchandisingRepository> = {}, signed = true) {
  const authorize = vi.fn(async (_ctx: unknown, request: { permissionKey: string }) => ({
    permissionKey: request.permissionKey,
  }));
  const authorization = { authorize } as unknown as AuthorizationService;
  const repository = {
    updateStorefrontContent: vi.fn(async (_proof: unknown, body: unknown) => body),
    ...overrides,
  } as unknown as MerchandisingRepository;
  const signer = {
    sign: vi.fn(async () =>
      signed ? { url: "https://storage.test/upload", expiresAt: "x" } : null,
    ),
  };
  return {
    authorize,
    repository,
    signer,
    svc: new MerchandisingService(authorization, repository, signer, () => "fixed-id"),
  };
}

const baseProduct = {
  id: "22222222-2222-4222-8222-222222222222",
  brandId: "33333333-3333-4333-8333-333333333333",
  slug: "tee",
  name: "Tee",
  description: null,
  publishedAt: "2026-11-01T10:00:00+00:00",
  media: [],
  variants: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      sku: "T-1",
      displayName: "M",
      optionSignature: "sig",
      prices: [{ currency: "EGP", amountMinor: "45000", compareAtAmountMinor: 69000 }],
      availableQuantity: "3",
    },
  ],
  offers: [
    { id: "55555555-5555-4555-8555-555555555555", name: "B2G1", buyQuantity: 2, getQuantity: 1 },
  ],
};

describe("public product shape", () => {
  it("exposes the sale price, the compare-at original, and live offers", () => {
    const product = shapePublicProduct(baseProduct);
    expect(product.variants[0]!.prices[0]).toEqual({
      currency: "EGP",
      amountMinor: 45000,
      compareAtAmountMinor: 69000,
    });
    expect(product.variants[0]!.inStock).toBe(true);
    expect(product.offers).toEqual([baseProduct.offers[0]]);
  });

  it("drops a compare-at that is not above the selling price and defaults offers", () => {
    const product = shapePublicProduct({
      ...baseProduct,
      offers: undefined,
      variants: [
        {
          ...baseProduct.variants[0]!,
          prices: [{ currency: "EGP", amountMinor: 45000, compareAtAmountMinor: 45000 }],
        },
      ],
    });
    expect(product.variants[0]!.prices[0]!.compareAtAmountMinor).toBeNull();
    expect(product.offers).toEqual([]);
  });
});

describe("merchandising service", () => {
  it("authorizes sales with promotions.* and content with catalog.author", async () => {
    const { svc, authorize } = service({
      listSales: vi.fn(async () => ({ items: [] })),
      getStorefrontContent: vi.fn(async () => ({}) as never),
    });
    await svc.listSales(context);
    await svc.getStorefrontContent(context);
    expect(authorize.mock.calls.map((call) => call[1].permissionKey)).toEqual([
      "promotions.read",
      "catalog.author",
    ]);
  });

  it("mints a server-chosen, tenant-scoped hero image destination", async () => {
    const { svc, signer } = service();
    const intent = await svc.createHeroImageIntent(context, { contentType: "image/webp" });
    expect(intent).toEqual({
      bucket: "product-media",
      path: `${TENANT}/storefront/fixed-id.webp`,
      contentType: "image/webp",
      uploadUrl: "https://storage.test/upload",
      expiresAt: "x",
    });
    expect(signer.sign).toHaveBeenCalledWith("product-media", intent.path, "image/webp");
  });

  it("returns uploadUrl null when storage cannot sign", async () => {
    const { svc } = service({}, false);
    const intent = await svc.createHeroImageIntent(context, { contentType: "image/png" });
    expect(intent.uploadUrl).toBeNull();
  });

  it("rejects a hero image that was not issued for this tenant", async () => {
    const { svc, repository } = service();
    const body = {
      hero: { image: { bucket: "product-media", path: "someone-else/storefront/x.png" } },
      featuredProductIds: [],
      featuredCollectionIds: [],
    };
    await expect(svc.updateStorefrontContent(context, body)).rejects.toBeInstanceOf(
      MerchandisingError,
    );
    expect(repository.updateStorefrontContent).not.toHaveBeenCalled();
  });

  it("accepts a tenant-scoped hero image", async () => {
    const { svc, repository } = service();
    await svc.updateStorefrontContent(context, {
      hero: {
        title: "Drop",
        image: { bucket: "product-media", path: `${TENANT}/storefront/a.png` },
      },
      featuredProductIds: [],
      featuredCollectionIds: [],
    });
    expect(repository.updateStorefrontContent).toHaveBeenCalledTimes(1);
  });
});

describe("merchandising contracts", () => {
  it("requires the benefit shape and scope targets for a sale", () => {
    expect(
      CreateSaleRequestSchema.safeParse({ name: "S", benefitType: "percentage", scope: "all" })
        .success,
    ).toBe(false);
    expect(
      CreateSaleRequestSchema.safeParse({
        name: "S",
        benefitType: "percentage",
        benefitPercentBp: 3400,
        scope: "products",
        productIds: [],
      }).success,
    ).toBe(false);
    expect(
      CreateSaleRequestSchema.safeParse({
        name: "S",
        benefitType: "fixed_amount",
        benefitAmountMinor: 5000,
        benefitCurrency: "EGP",
        scope: "all",
      }).success,
    ).toBe(true);
  });

  it("rejects unsafe call-to-action links", () => {
    const parse = (ctaHref: string) =>
      UpdateStorefrontContentRequestSchema.safeParse({
        hero: { ctaHref },
        featuredProductIds: [],
        featuredCollectionIds: [],
      }).success;
    expect(parse("/catalog")).toBe(true);
    expect(parse("https://example.com/a")).toBe(true);
    expect(parse("javascript:alert(1)")).toBe(false);
    expect(parse("//evil.example")).toBe(false);
  });

  it("requires buy/get quantities and keeps Buy-X-Get-Y online-only", () => {
    const base = { name: "B2G1", targetType: "order", activationType: "automatic" } as const;
    expect(
      CreatePromotionRequestSchema.safeParse({ ...base, benefitType: "buy_x_get_y" }).success,
    ).toBe(false);
    expect(
      CreatePromotionRequestSchema.safeParse({
        ...base,
        benefitType: "buy_x_get_y",
        buyQuantity: 2,
        getQuantity: 1,
        channel: "pos",
      }).success,
    ).toBe(false);
    expect(
      CreatePromotionRequestSchema.safeParse({
        ...base,
        benefitType: "buy_x_get_y",
        buyQuantity: 2,
        getQuantity: 1,
      }).success,
    ).toBe(true);
  });

  it("maps database codes to stable errors", () => {
    expect(merchandisingDatabaseError({ code: "SL404" }, "INVALID_SALE")).toMatchObject({
      code: "SALE_NOT_FOUND",
      httpStatus: 404,
    });
    expect(merchandisingDatabaseError({ code: "SC422" }, "INVALID_SALE")).toMatchObject({
      code: "INVALID_STOREFRONT_CONTENT",
      httpStatus: 422,
    });
    expect(merchandisingDatabaseError({ code: "XX000" }, "INVALID_SALE")).not.toBeInstanceOf(
      MerchandisingError,
    );
  });
});
