import { z } from "zod";

/**
 * Storefront SITE TEXT (SDK 0.52): every piece of website copy outside the catalog and the home hero —
 * promo bar, home section titles, brand note, sign-up box, empty-store message, footer, search-engine
 * title/description, contact details and the FAQ / Terms / Shipping & returns pages.
 *
 * One flat document per tenant, edited from Admin Mobile and the POS Website desk (catalog.author) and
 * read publicly by the Storefront. Every key is optional: a missing or null value means "use the
 * Storefront's built-in text", so a store that never edits anything looks exactly as before. Lists work
 * the same way, except that an EMPTY list is a deliberate choice (e.g. `announcements: []` hides the promo
 * bar, `faqItems: []` leaves the FAQ page with only its intro).
 *
 * Body text is plain text: blank lines separate paragraphs, lines starting with "- " are bullets, and
 * `[label](/path)` or `[label](https://…)` makes a link. `{storeName}` is replaced with the store name and,
 * on the Shipping & returns page, `{returnWindow}` with the live return-window sentence.
 * This is content, not layout: the Storefront owns where and how each piece is shown.
 */

const text = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

// Internal paths ("/catalog") or absolute https links only — same rule as the hero button.
const SafeHrefSchema = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "/" || /^\/[^/]/.test(v) || /^https:\/\//.test(v), {
    message: "Use an internal path such as /catalog, or an https:// link.",
  });

export const SiteTextFaqItemSchema = z
  .object({
    question: z.string().trim().min(1).max(200),
    answer: z.string().trim().min(1).max(2000),
  })
  .strict();

export const SiteTextSectionSchema = z
  .object({
    heading: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();

export const SiteTextSchema = z
  .object({
    // Store identity & search engines
    storeName: text(80),
    seoTitle: text(120),
    seoDescription: text(300),
    // Promo bar (null = automatic messages from live settings; [] = hide the bar)
    announcements: z.array(z.string().trim().min(1).max(120)).max(10).nullable().optional(),
    // Home page sections
    newArrivalsEyebrow: text(60),
    newArrivalsTitle: text(120),
    newArrivalsLink: text(40),
    bestSellersEyebrow: text(60),
    bestSellersTitle: text(120),
    bestSellersLink: text(40),
    featuredEyebrow: text(60),
    featuredLink: text(40),
    collectionsEyebrow: text(60),
    collectionsTitle: text(120),
    collectionsLink: text(40),
    brandNoteEyebrow: text(60),
    brandNoteTitle: text(160),
    brandNoteBody: text(600),
    brandNoteCtaLabel: text(40),
    brandNoteCtaHref: SafeHrefSchema.nullable().optional(),
    newsletterEyebrow: text(60),
    newsletterTitle: text(120),
    newsletterBody: text(400),
    emptyStoreEyebrow: text(60),
    emptyStoreTitle: text(120),
    emptyStoreBody: text(400),
    // Footer
    footerTagline: text(200),
    // Contact
    contactEmail: z.email().max(254).nullable().optional(),
    contactWhatsapp: z
      .string()
      .trim()
      .regex(/^\d{8,15}$/u, "Digits only, with the country code (e.g. 201001234567).")
      .nullable()
      .optional(),
    contactHours: text(120),
    contactEyebrow: text(60),
    contactTitle: text(120),
    contactIntro: text(600),
    contactOrderHelp: text(1500),
    // FAQ page
    faqEyebrow: text(60),
    faqTitle: text(120),
    faqIntro: text(600),
    faqItems: z.array(SiteTextFaqItemSchema).max(40).nullable().optional(),
    // Terms page
    termsEyebrow: text(60),
    termsTitle: text(120),
    termsIntro: text(600),
    termsSections: z.array(SiteTextSectionSchema).max(30).nullable().optional(),
    // Shipping & returns page
    shippingEyebrow: text(60),
    shippingTitle: text(120),
    shippingIntro: text(600),
    shippingSections: z.array(SiteTextSectionSchema).max(30).nullable().optional(),
  })
  .strict();

/** Management read/write shape: the document plus when it was last saved (null = never). */
export const StorefrontSiteTextSchema = z.object({
  siteText: SiteTextSchema,
  updatedAt: z.string().nullable(),
});

/** PUT body: the complete document (the editor always sends its whole state). */
export const UpdateStorefrontSiteTextRequestSchema = z
  .object({ siteText: SiteTextSchema })
  .strict();

/** PUBLIC read shape. */
export const PublicStorefrontSiteTextSchema = z.object({ siteText: SiteTextSchema });

export type SiteText = z.infer<typeof SiteTextSchema>;
export type SiteTextFaqItem = z.infer<typeof SiteTextFaqItemSchema>;
export type SiteTextSection = z.infer<typeof SiteTextSectionSchema>;
export type StorefrontSiteText = z.infer<typeof StorefrontSiteTextSchema>;
export type UpdateStorefrontSiteTextRequest = z.infer<typeof UpdateStorefrontSiteTextRequestSchema>;
export type PublicStorefrontSiteText = z.infer<typeof PublicStorefrontSiteTextSchema>;
