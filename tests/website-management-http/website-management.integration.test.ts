// Website management over the REAL HTTP server (Next.js API + disposable PostgreSQL), driven through the SDK the
// way Admin Mobile and the POS "Website" desk call it, then read back through the PUBLIC storefront endpoints the
// website renders from. Each case proves "an admin edit actually reaches the website".
//
//   M1  home content: hero copy + CTA + featured heading/products/collections → public content, in order
//   M2  hero image (bucket/path/alt) saved and served; clearing it falls back (null)
//   M3  unsafe CTA links are refused (javascript:, protocol-relative, http://)
//   M4  product name/slug/description edits reach the public product; unpublish hides it from list + featured
//   M5  product media registered with alt text appears on the public product
//   M6  collection name/description/products → public collection
//   M7  category name + size guide → public categories
//   M8  vendor ("Brand") create → public vendors
//   M9  delivery zones + free threshold → public delivery options
//   M10 return window → public return policy
//   M11 an operator without catalog.author / settings.manage is refused (403) with no effect
//   M12 site text: a fresh store reads an empty document (website keeps its built-in text)
//   M13 site text: every kind of field (text, promo list, FAQ, page sections, contact) round-trips to the
//       public read; blank/null values are not stored; an empty list is kept as a deliberate choice
//   M15 collection cover + category image: set → public list/detail/categories carry them; clear → fallback;
//       images outside "<tenant>/catalog/" are refused
//   M16 product photos: list in order, describe, choose the main photo, reorder (first = main); a photo
//       registered outside its product's upload path is refused; a partial order is refused
//   M14 site text: invalid values (unsafe link, bad email/phone, unknown key, too long) are refused, and an
//       operator without catalog.author cannot read or write it
//
// Launched exclusively by `pnpm test:website:http` (isolated rt-<hex> stack; never the shared dev DB).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ApiHttpError, createCommerceClient } from "../../packages/sdk/src/index";

const baseUrl = process.env.POS_TEST_API_BASE_URL;
const token = process.env.POS_TEST_CLERK_TOKEN;
const restrictedToken = process.env.POS_TEST_CLERK_TOKEN_RESTRICTED;
if (!baseUrl || !token || !restrictedToken)
  throw new Error("Run through `pnpm test:website:http` (isolated harness environment).");

const T = "2a000001-0000-4000-8000-000000000001";
const B = "2a000002-0000-4000-8000-000000000001";
const P = "2a000006-0000-4000-8000-000000000001";
const key = (p: string) => `${p}-${randomUUID()}`;

const pub = createCommerceClient({ baseUrl });
const staff = createCommerceClient({ baseUrl, getToken: () => token }).withTenant(T);
const restricted = createCommerceClient({ baseUrl, getToken: () => restrictedToken }).withTenant(T);

async function expectApiError(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiHttpError);
  expect((error as ApiHttpError).status).toBe(status);
}

let collectionId = "";
let collectionSlug = "";

describe("website management reaches the public storefront", () => {
  it("M6: collection create/edit/products → public collection", async () => {
    collectionSlug = `summer-${randomUUID().slice(0, 8)}`;
    const created = await staff.createCollection({
      idempotencyKey: key("col"),
      name: "Summer edit",
      slug: collectionSlug,
      description: "First draft",
    });
    collectionId = created.collectionId;
    expect(collectionId).toBeTruthy();
    await staff.setCollectionProducts({
      idempotencyKey: key("colp"),
      collectionId,
      productIds: [P],
    });
    await staff.updateCollection({
      idempotencyKey: key("colu"),
      collectionId,
      name: "Summer Edit 26",
      slug: collectionSlug,
      description: "Linen and light layers.",
    });
    await staff.setCollectionStatus({
      idempotencyKey: key("cols"),
      collectionId,
      status: "active",
    });
    const detail = await pub.getPublishedCollection({ tenantId: T, slug: collectionSlug });
    const c = (detail as { collection?: Record<string, unknown> }).collection ?? detail;
    expect(c).toMatchObject({ name: "Summer Edit 26", description: "Linen and light layers." });
    expect(JSON.stringify(detail)).toContain(P);
  });

  it("M1: hero copy, CTA, featured heading/products/collections reach the public content", async () => {
    await staff.updateStorefrontContent({
      idempotencyKey: key("content"),
      hero: {
        eyebrow: "Drop 04",
        title: "Linen season",
        subtitle: "Breathable pieces for hot days.",
        ctaLabel: "Shop linen",
        ctaHref: `/collections/${collectionSlug}`,
        image: null,
      },
      featuredHeading: "Staff picks",
      featuredProductIds: [P],
      featuredCollectionIds: [collectionId],
    });
    const content = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(content.hero).toMatchObject({
      eyebrow: "Drop 04",
      title: "Linen season",
      subtitle: "Breathable pieces for hot days.",
      ctaLabel: "Shop linen",
      ctaHref: `/collections/${collectionSlug}`,
      image: null,
    });
    expect(content.featuredHeading).toBe("Staff picks");
    expect(content.featuredProducts.map((p) => p.id)).toEqual([P]);
    expect(content.featuredCollections.map((c) => c.id)).toEqual([collectionId]);
  });

  it("M2: hero image is saved and served, and can be cleared", async () => {
    const intent = await staff
      .createStorefrontHeroImageIntent({ contentType: "image/webp", fileName: "hero.webp" })
      .catch((e: unknown) => e);
    // Storage is not part of the isolated stack; when it answers, the destination must be tenant-scoped.
    if (!(intent instanceof Error))
      expect((intent as { path: string }).path.startsWith(`${T}/storefront/`)).toBe(true);
    const path = `${T}/storefront/hero-test.webp`;
    const base = await staff.getStorefrontContent();
    const hero = {
      eyebrow: base.hero.eyebrow,
      title: base.hero.title,
      subtitle: base.hero.subtitle,
      ctaLabel: base.hero.ctaLabel,
      ctaHref: base.hero.ctaHref,
    };
    const rest = {
      featuredHeading: base.featuredHeading,
      featuredProductIds: base.featuredProductIds,
      featuredCollectionIds: base.featuredCollectionIds,
    };
    await staff.updateStorefrontContent({
      idempotencyKey: key("hero-img"),
      hero: { ...hero, image: { bucket: "product-media", path, altText: "Model in linen shirt" } },
      ...rest,
    });
    let content = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(content.hero?.image).toMatchObject({ path, altText: "Model in linen shirt" });
    await staff.updateStorefrontContent({
      idempotencyKey: key("hero-clear"),
      hero: { ...hero, image: null },
      ...rest,
    });
    content = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(content.hero?.image).toBeNull();
    expect(content.hero?.title).toBe("Linen season");
  });

  it("M3: unsafe CTA links are refused", async () => {
    for (const ctaHref of ["javascript:alert(1)", "//evil.example", "http://plain.example"]) {
      await expectApiError(
        staff.updateStorefrontContent({
          idempotencyKey: key("bad-cta"),
          hero: { ctaHref },
          featuredProductIds: [],
          featuredCollectionIds: [],
        }),
        400,
      );
    }
    const content = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(content.hero?.ctaHref).toBe(`/collections/${collectionSlug}`);
  });

  it("M4/M5: product text + media edits reach the public product; unpublish hides it", async () => {
    await staff.updateProduct({
      idempotencyKey: key("prod"),
      productId: P,
      name: "Linen Camp Shirt",
      slug: "linen-camp-shirt",
      description: "Relaxed camp collar in washed linen.",
    });
    await staff.registerProductMedia({
      idempotencyKey: key("media"),
      productId: P,
      bucket: "product-media",
      path: `${T}/${P}/front.webp`,
      altText: "Front view",
      isPrimary: true,
    });
    const detail = await pub.getPublishedProduct({ tenantId: T, slug: "linen-camp-shirt" });
    const product = (detail as { product?: Record<string, unknown> }).product ?? detail;
    expect(product).toMatchObject({
      name: "Linen Camp Shirt",
      description: "Relaxed camp collar in washed linen.",
    });
    expect(JSON.stringify(product)).toContain("Front view");
    await expectApiError(pub.getPublishedProduct({ tenantId: T, slug: "pos-tee" }), 404);

    await staff.unpublishProduct({ idempotencyKey: key("unpub"), productId: P });
    const list = await pub.listPublishedProducts({ tenantId: T });
    expect(JSON.stringify(list)).not.toContain(P);
    const content = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(content.featuredProducts).toEqual([]);
    await staff.publishProduct({ idempotencyKey: key("repub"), productId: P });
    const back = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(back.featuredProducts.map((p) => p.id)).toEqual([P]);
  });

  it("M7: category name + size guide reach the public categories", async () => {
    const slug = `shirts-${randomUUID().slice(0, 8)}`;
    const created = await staff.createCategory({
      idempotencyKey: key("cat"),
      parentId: null,
      name: "Shirts",
      slug,
    });
    const categoryId = created.categoryId;
    await staff.updateCategory({
      idempotencyKey: key("catu"),
      categoryId,
      parentId: null,
      name: "Shirts & Overshirts",
      slug,
      description: "Button-ups for every day.",
    });
    await staff.setCategorySizeGuide({
      idempotencyKey: key("sg"),
      categoryId,
      sizeGuide: {
        title: "Shirt sizes",
        unit: "cm",
        columns: ["Chest"],
        rows: [{ size: "M", values: ["100"] }],
        note: null,
      },
    });
    await staff.setProductCategories({
      idempotencyKey: key("pc"),
      productId: P,
      categoryIds: [categoryId],
    });
    const cats = await pub.listStorefrontCategories({ tenantId: T });
    const text = JSON.stringify(cats);
    expect(text).toContain("Shirts & Overshirts");
    const product = await pub.getPublishedProduct({ tenantId: T, slug: "linen-camp-shirt" });
    expect(JSON.stringify(product)).toContain("Shirt sizes");
  });

  it("M8: a new brand (vendor) reaches the public brands list", async () => {
    const slug = `zee-label-${randomUUID().slice(0, 8)}`;
    const created = await staff.createVendor({
      idempotencyKey: key("ven"),
      name: "Zee Label",
      slug,
    });
    const vendorId = created.vendorId;
    await staff.setProductVendor({ idempotencyKey: key("pv"), productId: P, vendorId });
    const vendors = await pub.listStorefrontVendors({ tenantId: T });
    expect(JSON.stringify(vendors)).toContain("Zee Label");
  });

  it("M9: delivery zones + free threshold reach the public delivery options", async () => {
    await staff.updateStorefrontDeliverySettings({
      idempotencyKey: key("del"),
      brandId: B,
      freeDeliveryThresholdMinor: 150000,
      zones: [
        { code: "EG-C", name: "Cairo", feeMinor: 5000 },
        { code: "EG-ALX", name: "Alexandria", feeMinor: 7000 },
      ],
    });
    const options = await pub.getStorefrontDeliveryOptions({ tenantId: T, brandId: B });
    expect(options.freeDeliveryThresholdMinor).toBe(150000);
    expect(options.zones.map((z) => [z.code, z.feeMinor])).toEqual([
      ["EG-C", 5000],
      ["EG-ALX", 7000],
    ]);
  });

  it("M10: return window reaches the public return policy", async () => {
    await staff.updateReturnSettings({ idempotencyKey: key("ret"), enabled: true, windowDays: 21 });
    const policy = await pub.getStorefrontReturnPolicy({ tenantId: T });
    expect(policy).toMatchObject({ acceptingReturns: true, windowDays: 21 });
  });

  it("M12: a fresh store reads an empty site text document", async () => {
    expect(await pub.getPublicStorefrontSiteText({ tenantId: T })).toEqual({ siteText: {} });
    expect(await staff.getStorefrontSiteText()).toEqual({ siteText: {}, updatedAt: null });
  });

  it("M13: every kind of site text field reaches the public read", async () => {
    const saved = await staff.updateStorefrontSiteText({
      idempotencyKey: key("site"),
      siteText: {
        storeName: "Nile Wear",
        seoTitle: "Nile Wear — linen for hot days",
        announcements: ["Free returns this week", "Cash on delivery"],
        newArrivalsTitle: "Fresh in",
        brandNoteCtaHref: "/collections/linen",
        footerTagline: "Made for the heat.",
        contactEmail: "help@nilewear.example",
        contactWhatsapp: "201001234567",
        faqItems: [
          { question: "Do you ship to Aswan?", answer: "Yes — see [shipping](/shipping-returns)." },
        ],
        termsSections: [],
        shippingSections: [{ heading: "Delivery", body: "2–4 days.\n\n{returnWindow}" }],
        faqTitle: null,
      },
    });
    expect(saved.updatedAt).not.toBeNull();
    expect(saved.siteText).not.toHaveProperty("faqTitle");
    const { siteText } = await pub.getPublicStorefrontSiteText({ tenantId: T });
    expect(siteText).toMatchObject({
      storeName: "Nile Wear",
      announcements: ["Free returns this week", "Cash on delivery"],
      newArrivalsTitle: "Fresh in",
      contactWhatsapp: "201001234567",
      termsSections: [],
    });
    expect(siteText.faqItems).toHaveLength(1);
    expect(siteText.shippingSections?.[0]?.body).toContain("{returnWindow}");

    // Clearing a field (sending the whole document without it) brings back the built-in text.
    const rest = { ...siteText };
    delete rest.faqItems;
    await staff.updateStorefrontSiteText({ idempotencyKey: key("site2"), siteText: rest });
    const again = await pub.getPublicStorefrontSiteText({ tenantId: T });
    expect(again.siteText).not.toHaveProperty("faqItems");
    expect(again.siteText.storeName).toBe("Nile Wear");
  });

  it("M14: invalid site text is refused and unauthorized operators are blocked", async () => {
    const bad: Record<string, unknown>[] = [
      { brandNoteCtaHref: "javascript:alert(1)" },
      { contactEmail: "not-an-email" },
      { contactWhatsapp: "+20 100 123" },
      { newArrivalsLink: "x".repeat(41) },
      { madeUpKey: "nope" },
      { faqItems: [{ question: "", answer: "a" }] },
    ];
    for (const siteText of bad) {
      await expectApiError(
        staff.updateStorefrontSiteText({
          idempotencyKey: key("bad-site"),
          siteText: siteText as never,
        }),
        400,
      );
    }
    await expectApiError(restricted.getStorefrontSiteText(), 403);
    await expectApiError(
      restricted.updateStorefrontSiteText({ idempotencyKey: key("deny-site"), siteText: {} }),
      403,
    );
    expect((await pub.getPublicStorefrontSiteText({ tenantId: T })).siteText.storeName).toBe(
      "Nile Wear",
    );
  });

  it("M15: collection covers and category images reach the website, and can be cleared", async () => {
    const intent = await staff
      .createCatalogImageIntent({ contentType: "image/webp" })
      .catch((e: unknown) => e);
    if (!(intent instanceof Error))
      expect((intent as { path: string }).path.startsWith(`${T}/catalog/`)).toBe(true);
    const cover = {
      bucket: "product-media",
      path: `${T}/catalog/cover.webp`,
      altText: "Linen rail",
    };

    await staff.setCollectionImage({ idempotencyKey: key("ci"), collectionId, image: cover });
    const list = await pub.listPublishedCollections({ tenantId: T });
    const summary = list.collections.find((c) => c.id === collectionId);
    expect(summary?.cover).toEqual(cover);
    const detail = await pub.getPublishedCollection({ tenantId: T, slug: collectionSlug });
    expect(detail.cover).toEqual(cover);
    const managed = await staff.getCollection(collectionId);
    expect(managed.collection.image).toEqual(cover);
    const content = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(content.featuredCollections[0]?.cover).toEqual(cover);

    await expectApiError(
      staff.setCollectionImage({
        idempotencyKey: key("ci-bad"),
        collectionId,
        image: { bucket: "product-media", path: `${T}/storefront/x.webp` },
      }),
      400,
    );
    await staff.setCollectionImage({ idempotencyKey: key("ci-clear"), collectionId, image: null });
    const cleared = await pub.getPublishedCollection({ tenantId: T, slug: collectionSlug });
    expect(cleared.cover ?? null).toBeNull();

    const categories = await staff.listCategories();
    const category = categories.categories.find((c) => c.name === "Shirts & Overshirts");
    expect(category).toBeDefined();
    const tile = { bucket: "product-media", path: `${T}/catalog/shirts.webp`, altText: null };
    await staff.setCategoryImage({
      idempotencyKey: key("cat-img"),
      categoryId: category!.id,
      image: tile,
    });
    const publicCats = await pub.listStorefrontCategories({ tenantId: T });
    expect(publicCats.categories.find((c) => c.id === category!.id)?.image).toEqual(tile);
    const again = await staff.listCategories();
    expect(again.categories.find((c) => c.id === category!.id)?.image).toEqual(tile);
  });

  it("M16: product photos can be listed, described, made main and reordered", async () => {
    const second = await staff.registerProductMedia({
      idempotencyKey: key("m2"),
      productId: P,
      bucket: "product-media",
      path: `${T}/${P}/back.webp`,
    });
    await expectApiError(
      staff.registerProductMedia({
        idempotencyKey: key("m-bad"),
        productId: P,
        bucket: "product-media",
        path: `${T}/someone-else/x.webp`,
      }),
      400,
    );
    let { media } = await staff.listProductMedia(P);
    expect(media.map((m) => m.altText)).toEqual(["Front view", null]);
    expect(media[0]!.isPrimary).toBe(true);

    await staff.updateProductMedia({
      idempotencyKey: key("alt"),
      productId: P,
      mediaId: second.mediaId,
      altText: "Back view",
      isPrimary: true,
    });
    ({ media } = await staff.listProductMedia(P));
    expect(media[0]).toMatchObject({ id: second.mediaId, isPrimary: true, altText: "Back view" });
    expect(media.filter((m) => m.isPrimary)).toHaveLength(1);

    const reversed = [...media].reverse().map((m) => m.id);
    await staff.reorderProductMedia({
      idempotencyKey: key("ord"),
      productId: P,
      mediaIds: reversed,
    });
    ({ media } = await staff.listProductMedia(P));
    expect(media.map((m) => m.id)).toEqual(reversed);
    expect(media[0]!.isPrimary).toBe(true);
    const product = await pub.getPublishedProduct({ tenantId: T, slug: "linen-camp-shirt" });
    const pubMedia = (product as { media: { path: string; isPrimary?: boolean }[] }).media;
    expect(JSON.stringify(pubMedia)).toContain("front.webp");

    await expectApiError(
      staff.reorderProductMedia({
        idempotencyKey: key("ord-bad"),
        productId: P,
        mediaIds: [reversed[0]!],
      }),
      400,
    );
  });

  it("M11: an operator without website authority is refused with no effect", async () => {
    await expectApiError(
      restricted.updateStorefrontContent({
        idempotencyKey: key("deny"),
        hero: { title: "Hacked" },
        featuredProductIds: [],
        featuredCollectionIds: [],
      }),
      403,
    );
    await expectApiError(
      restricted.updateStorefrontDeliverySettings({
        idempotencyKey: key("deny-del"),
        brandId: B,
        freeDeliveryThresholdMinor: 0,
        zones: [],
      }),
      403,
    );
    const content = await pub.getPublicStorefrontContent({ tenantId: T, brandId: B });
    expect(content.hero?.title).toBe("Linen season");
  });
});
