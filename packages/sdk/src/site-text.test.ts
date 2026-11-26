import { describe, expect, it } from "vitest";

import { SiteTextSchema } from "../../../src/contracts/storefront/site-text";
import {
  buildSiteTextRequest,
  defaultSiteTextList,
  isSiteTextFormDirty,
  parseSiteTextBody,
  resolveSiteText,
  SITE_TEXT_DEFAULTS,
  SITE_TEXT_FIELDS,
  SITE_TEXT_GROUPS,
  SITE_TEXT_TEXT_KEYS,
  siteTextIssueMessage,
  siteTextPlaceholder,
  siteTextToForm,
  validateSiteTextForm,
} from "./site-text";

describe("site text catalog", () => {
  it("covers every contract key exactly once across the editor groups", () => {
    const contractKeys = Object.keys(SiteTextSchema.shape).sort();
    const grouped = SITE_TEXT_GROUPS.flatMap((g) => g.fields);
    expect([...grouped].sort()).toEqual(contractKeys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(Object.keys(SITE_TEXT_FIELDS).sort()).toEqual(contractKeys);
  });

  it("every field and group has English and Arabic labels", () => {
    for (const def of Object.values(SITE_TEXT_FIELDS)) {
      expect(def.label.en.length).toBeGreaterThan(0);
      expect(def.label.ar.length).toBeGreaterThan(0);
    }
    for (const group of SITE_TEXT_GROUPS) expect(group.label.ar.length).toBeGreaterThan(0);
  });

  it("the built-in defaults satisfy the API contract", () => {
    const doc = buildSiteTextRequest({
      ...siteTextToForm(null),
      texts: {
        ...SITE_TEXT_DEFAULTS,
        contactEmail: "help@example.com",
        contactWhatsapp: "201001234567",
      },
      announcements: defaultSiteTextList("announcements") as string[],
      faqItems: defaultSiteTextList("faqItems") as never,
      termsSections: defaultSiteTextList("termsSections") as never,
      shippingSections: defaultSiteTextList("shippingSections") as never,
    });
    expect(SiteTextSchema.safeParse(doc).success).toBe(true);
  });
});

describe("resolveSiteText", () => {
  it("falls back to built-in text and fills the store name", () => {
    const resolved = resolveSiteText({});
    expect(resolved.texts.newArrivalsTitle).toBe("New arrivals");
    expect(resolved.texts.seoTitle).toBe("Zee Store — Everyday fits, fresh drops");
    expect(resolved.announcements).toBeNull();
    expect(resolved.faqItems.length).toBeGreaterThan(0);
  });

  it("uses admin values, including a renamed store and an emptied list", () => {
    const resolved = resolveSiteText({
      storeName: "Nile Wear",
      newArrivalsTitle: "Fresh in",
      announcements: [],
      faqItems: [{ question: "Q?", answer: "Shop at {storeName}." }],
    });
    expect(resolved.texts.newArrivalsTitle).toBe("Fresh in");
    expect(resolved.texts.seoTitle).toBe("Nile Wear — Everyday fits, fresh drops");
    expect(resolved.announcements).toEqual([]);
    expect(resolved.faqItems).toEqual([{ question: "Q?", answer: "Shop at Nile Wear." }]);
  });
});

describe("parseSiteTextBody", () => {
  it("splits paragraphs and bullets and keeps only safe links", () => {
    const blocks = parseSiteTextBody(
      "Hello [track](/track) and [bad](javascript:alert(1)).\n\n- one\n- [two](https://x.example)",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        inlines: [
          { type: "text", text: "Hello " },
          { type: "link", text: "track", href: "/track" },
          { type: "text", text: " and " },
          { type: "text", text: "bad" },
          { type: "text", text: ")." },
        ],
      },
      {
        type: "list",
        items: [
          [{ type: "text", text: "one" }],
          [{ type: "link", text: "two", href: "https://x.example" }],
        ],
      },
    ]);
  });
});

describe("editor form", () => {
  it("round-trips a document and treats blanks as built-in", () => {
    const form = siteTextToForm({ footerTagline: "Hi", faqItems: [] });
    expect(form.texts.footerTagline).toBe("Hi");
    expect(form.texts.faqTitle).toBe("");
    expect(form.faqItems).toEqual([]);
    expect(form.termsSections).toBeNull();
    const doc = buildSiteTextRequest({ ...form, texts: { ...form.texts, faqTitle: "  " } });
    expect(doc.faqTitle).toBeNull();
    expect(doc.footerTagline).toBe("Hi");
    expect(doc.faqItems).toEqual([]);
    expect(doc.termsSections).toBeNull();
    expect(SITE_TEXT_TEXT_KEYS.every((k) => k in doc)).toBe(true);
  });

  it("validates lengths, links, email, phone and list items", () => {
    const form = siteTextToForm(null);
    form.texts.newArrivalsLink = "x".repeat(41);
    form.texts.brandNoteCtaHref = "javascript:alert(1)";
    form.texts.contactEmail = "nope";
    form.texts.contactWhatsapp = "+20 100";
    form.faqItems = [{ question: "Q", answer: " " }];
    const issues = validateSiteTextForm(form);
    expect(issues.newArrivalsLink).toEqual({ code: "too_long", max: 40 });
    expect(issues.brandNoteCtaHref?.code).toBe("unsafe_link");
    expect(issues.contactEmail?.code).toBe("email_format");
    expect(issues.contactWhatsapp?.code).toBe("phone_format");
    expect(issues.faqItems).toEqual({ code: "item_required", index: 0 });
    expect(siteTextIssueMessage(issues.faqItems!, "en")).toContain("Item 1");
    expect(siteTextIssueMessage(issues.newArrivalsLink!, "ar")).toContain("40");
    expect(validateSiteTextForm(siteTextToForm(null))).toEqual({});
  });

  it("shows built-in text as the placeholder and detects changes", () => {
    const form = siteTextToForm(null);
    expect(siteTextPlaceholder("faqIntro", form)).toContain("Zee Store");
    const renamed = { ...form, texts: { ...form.texts, storeName: "Nile Wear" } };
    expect(siteTextPlaceholder("faqIntro", renamed)).toContain("Nile Wear");
    expect(isSiteTextFormDirty(form, renamed)).toBe(true);
    expect(isSiteTextFormDirty(form, siteTextToForm({}))).toBe(false);
  });
});
