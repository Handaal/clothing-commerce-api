import type {
  SiteText,
  SiteTextFaqItem,
  SiteTextSection,
} from "../../../src/contracts/storefront/site-text";

// Storefront SITE TEXT (SDK 0.52) — one shared definition for the three channels:
//   • the Storefront renders `resolveSiteText(document)` (admin text, else the built-in default);
//   • Admin Mobile and the POS Website desk render the SAME editor from `SITE_TEXT_GROUPS` /
//     `SITE_TEXT_FIELDS`, and use `siteTextToForm` / `validateSiteTextForm` / `buildSiteTextRequest`.
// Unlike the other form rules (language-neutral issue codes), site text is a long, fixed list of fields,
// so its labels, hints and issue messages ship here in both platform languages (English + Arabic) and
// each app just picks its current language. The defaults are the website's built-in English copy;
// `{storeName}` is replaced with the store name and `{returnWindow}` (Shipping page only) with the live
// return-window sentence. The Commerce API re-validates every field (src/contracts/storefront/site-text.ts).

export type SiteTextLanguage = "en" | "ar";
export type Bilingual = Readonly<Record<SiteTextLanguage, string>>;

export type SiteTextTextKey = {
  [K in keyof SiteText]-?: NonNullable<SiteText[K]> extends string ? K : never;
}[keyof SiteText];
export type SiteTextListKey = "announcements" | "faqItems" | "termsSections" | "shippingSections";

export type SiteTextFieldKind =
  "text" | "multiline" | "email" | "phone" | "link" | "messages" | "faq" | "sections";

export interface SiteTextFieldDef {
  kind: SiteTextFieldKind;
  label: Bilingual;
  hint?: Bilingual;
  /** Character limit (text kinds) or item limit (list kinds). */
  max: number;
  /** Per-item limits for list kinds. */
  itemMax?: { a: number; b?: number };
}

const L = (en: string, ar: string): Bilingual => ({ en, ar });
const BODY_HINT = L(
  "Blank line = new paragraph. Start a line with “- ” for a bullet. [Text](/path) makes a link. {storeName} = your store name.",
  "سطر فارغ = فقرة جديدة. ابدأ السطر بـ «- » لنقطة. ‎[نص](/path)‎ ينشئ رابطًا. ‎{storeName}‎ = اسم المتجر.",
);

export const SITE_TEXT_FIELDS: Readonly<
  Record<SiteTextTextKey | SiteTextListKey, SiteTextFieldDef>
> = {
  storeName: { kind: "text", max: 80, label: L("Store name", "اسم المتجر") },
  seoTitle: {
    kind: "text",
    max: 120,
    label: L("Search & share title", "عنوان البحث والمشاركة"),
    hint: L(
      "Shown in Google results, browser tabs and link previews.",
      "يظهر في نتائج جوجل وتبويبات المتصفح ومعاينات الروابط.",
    ),
  },
  seoDescription: {
    kind: "multiline",
    max: 300,
    label: L("Search & share description", "وصف البحث والمشاركة"),
  },
  announcements: {
    kind: "messages",
    max: 10,
    itemMax: { a: 120 },
    label: L("Promo bar messages", "رسائل الشريط الترويجي"),
    hint: L(
      "Built-in shows live facts (free-delivery threshold, cash on delivery). Remove every message to hide the bar.",
      "الافتراضي يعرض معلومات حية (حد التوصيل المجاني، الدفع عند الاستلام). احذف كل الرسائل لإخفاء الشريط.",
    ),
  },
  newArrivalsEyebrow: {
    kind: "text",
    max: 60,
    label: L("New arrivals — small label", "وصل حديثًا — العنوان الصغير"),
  },
  newArrivalsTitle: {
    kind: "text",
    max: 120,
    label: L("New arrivals — title", "وصل حديثًا — العنوان"),
  },
  newArrivalsLink: {
    kind: "text",
    max: 40,
    label: L("New arrivals — link text", "وصل حديثًا — نص الرابط"),
  },
  bestSellersEyebrow: {
    kind: "text",
    max: 60,
    label: L("Best sellers — small label", "الأكثر مبيعًا — العنوان الصغير"),
  },
  bestSellersTitle: {
    kind: "text",
    max: 120,
    label: L("Best sellers — title", "الأكثر مبيعًا — العنوان"),
  },
  bestSellersLink: {
    kind: "text",
    max: 40,
    label: L("Best sellers — link text", "الأكثر مبيعًا — نص الرابط"),
  },
  featuredEyebrow: {
    kind: "text",
    max: 60,
    label: L("Featured picks — small label", "المختارات — العنوان الصغير"),
    hint: L(
      "The title of this section is set on the Home page screen.",
      "عنوان هذا القسم يُضبط من شاشة الصفحة الرئيسية.",
    ),
  },
  featuredLink: {
    kind: "text",
    max: 40,
    label: L("Featured picks — link text", "المختارات — نص الرابط"),
  },
  collectionsEyebrow: {
    kind: "text",
    max: 60,
    label: L("Collections — small label", "المجموعات — العنوان الصغير"),
  },
  collectionsTitle: {
    kind: "text",
    max: 120,
    label: L("Collections — title", "المجموعات — العنوان"),
  },
  collectionsLink: {
    kind: "text",
    max: 40,
    label: L("Collections — link text", "المجموعات — نص الرابط"),
  },
  brandNoteEyebrow: {
    kind: "text",
    max: 60,
    label: L("Brand note — small label", "نبذة المتجر — العنوان الصغير"),
  },
  brandNoteTitle: {
    kind: "text",
    max: 160,
    label: L("Brand note — title", "نبذة المتجر — العنوان"),
  },
  brandNoteBody: {
    kind: "multiline",
    max: 600,
    label: L("Brand note — text", "نبذة المتجر — النص"),
  },
  brandNoteCtaLabel: {
    kind: "text",
    max: 40,
    label: L("Brand note — button text", "نبذة المتجر — نص الزر"),
  },
  brandNoteCtaHref: {
    kind: "link",
    max: 300,
    label: L("Brand note — button link", "نبذة المتجر — رابط الزر"),
    hint: L(
      "An internal path such as /catalog, or an https:// link.",
      "مسار داخلي مثل ‎/catalog‎ أو رابط ‎https://‎.",
    ),
  },
  newsletterEyebrow: {
    kind: "text",
    max: 60,
    label: L("Sign-up box — small label", "صندوق الاشتراك — العنوان الصغير"),
  },
  newsletterTitle: {
    kind: "text",
    max: 120,
    label: L("Sign-up box — title", "صندوق الاشتراك — العنوان"),
  },
  newsletterBody: {
    kind: "multiline",
    max: 400,
    label: L("Sign-up box — text", "صندوق الاشتراك — النص"),
  },
  emptyStoreEyebrow: {
    kind: "text",
    max: 60,
    label: L("Empty store — small label", "متجر فارغ — العنوان الصغير"),
  },
  emptyStoreTitle: {
    kind: "text",
    max: 120,
    label: L("Empty store — title", "متجر فارغ — العنوان"),
    hint: L(
      "Shown on the home page while nothing is published.",
      "يظهر في الصفحة الرئيسية طالما لا توجد منتجات منشورة.",
    ),
  },
  emptyStoreBody: {
    kind: "multiline",
    max: 400,
    label: L("Empty store — text", "متجر فارغ — النص"),
  },
  footerTagline: { kind: "multiline", max: 200, label: L("Footer tagline", "شعار التذييل") },
  contactEmail: { kind: "email", max: 254, label: L("Support email", "بريد الدعم") },
  contactWhatsapp: {
    kind: "phone",
    max: 15,
    label: L("WhatsApp number", "رقم واتساب"),
    hint: L(
      "Digits only with the country code, e.g. 201001234567.",
      "أرقام فقط مع كود الدولة، مثل 201001234567.",
    ),
  },
  contactHours: { kind: "text", max: 120, label: L("Opening hours", "مواعيد العمل") },
  contactEyebrow: {
    kind: "text",
    max: 60,
    label: L("Contact page — small label", "صفحة التواصل — العنوان الصغير"),
  },
  contactTitle: {
    kind: "text",
    max: 120,
    label: L("Contact page — title", "صفحة التواصل — العنوان"),
  },
  contactIntro: {
    kind: "multiline",
    max: 600,
    label: L("Contact page — intro", "صفحة التواصل — المقدمة"),
  },
  contactOrderHelp: {
    kind: "multiline",
    max: 1500,
    label: L("Contact page — order help", "صفحة التواصل — المساعدة في الطلبات"),
    hint: BODY_HINT,
  },
  faqEyebrow: {
    kind: "text",
    max: 60,
    label: L("FAQ page — small label", "صفحة الأسئلة — العنوان الصغير"),
  },
  faqTitle: { kind: "text", max: 120, label: L("FAQ page — title", "صفحة الأسئلة — العنوان") },
  faqIntro: {
    kind: "multiline",
    max: 600,
    label: L("FAQ page — intro", "صفحة الأسئلة — المقدمة"),
    hint: BODY_HINT,
  },
  faqItems: {
    kind: "faq",
    max: 40,
    itemMax: { a: 200, b: 2000 },
    label: L("Questions & answers", "الأسئلة والأجوبة"),
    hint: BODY_HINT,
  },
  termsEyebrow: {
    kind: "text",
    max: 60,
    label: L("Terms page — small label", "صفحة الشروط — العنوان الصغير"),
  },
  termsTitle: { kind: "text", max: 120, label: L("Terms page — title", "صفحة الشروط — العنوان") },
  termsIntro: {
    kind: "multiline",
    max: 600,
    label: L("Terms page — intro", "صفحة الشروط — المقدمة"),
    hint: BODY_HINT,
  },
  termsSections: {
    kind: "sections",
    max: 30,
    itemMax: { a: 120, b: 4000 },
    label: L("Terms sections", "أقسام الشروط"),
    hint: BODY_HINT,
  },
  shippingEyebrow: {
    kind: "text",
    max: 60,
    label: L("Shipping page — small label", "صفحة الشحن — العنوان الصغير"),
  },
  shippingTitle: {
    kind: "text",
    max: 120,
    label: L("Shipping page — title", "صفحة الشحن — العنوان"),
  },
  shippingIntro: {
    kind: "multiline",
    max: 600,
    label: L("Shipping page — intro", "صفحة الشحن — المقدمة"),
    hint: BODY_HINT,
  },
  shippingSections: {
    kind: "sections",
    max: 30,
    itemMax: { a: 120, b: 4000 },
    label: L("Shipping & returns sections", "أقسام الشحن والاسترجاع"),
    hint: L(
      "{returnWindow} shows your live return window (from Settings → Returns). " + BODY_HINT.en,
      "‎{returnWindow}‎ يعرض مدة الاسترجاع الحالية (من الإعدادات ← الاسترجاع). " + BODY_HINT.ar,
    ),
  },
};

export interface SiteTextGroup {
  id: string;
  label: Bilingual;
  fields: readonly (SiteTextTextKey | SiteTextListKey)[];
}

/** Editor sections, in the order a store owner meets them on the website. */
export const SITE_TEXT_GROUPS: readonly SiteTextGroup[] = [
  {
    id: "identity",
    label: L("Store & search engines", "المتجر ومحركات البحث"),
    fields: ["storeName", "seoTitle", "seoDescription"],
  },
  { id: "promo", label: L("Promo bar", "الشريط الترويجي"), fields: ["announcements"] },
  {
    id: "home",
    label: L("Home page sections", "أقسام الصفحة الرئيسية"),
    fields: [
      "newArrivalsEyebrow",
      "newArrivalsTitle",
      "newArrivalsLink",
      "bestSellersEyebrow",
      "bestSellersTitle",
      "bestSellersLink",
      "featuredEyebrow",
      "featuredLink",
      "collectionsEyebrow",
      "collectionsTitle",
      "collectionsLink",
      "emptyStoreEyebrow",
      "emptyStoreTitle",
      "emptyStoreBody",
    ],
  },
  {
    id: "brand",
    label: L("Brand note & sign-up box", "نبذة المتجر وصندوق الاشتراك"),
    fields: [
      "brandNoteEyebrow",
      "brandNoteTitle",
      "brandNoteBody",
      "brandNoteCtaLabel",
      "brandNoteCtaHref",
      "newsletterEyebrow",
      "newsletterTitle",
      "newsletterBody",
    ],
  },
  { id: "footer", label: L("Footer", "التذييل"), fields: ["footerTagline"] },
  {
    id: "contact",
    label: L("Contact details & page", "بيانات وصفحة التواصل"),
    fields: [
      "contactEmail",
      "contactWhatsapp",
      "contactHours",
      "contactEyebrow",
      "contactTitle",
      "contactIntro",
      "contactOrderHelp",
    ],
  },
  {
    id: "faq",
    label: L("FAQ page", "صفحة الأسئلة الشائعة"),
    fields: ["faqEyebrow", "faqTitle", "faqIntro", "faqItems"],
  },
  {
    id: "terms",
    label: L("Terms page", "صفحة الشروط"),
    fields: ["termsEyebrow", "termsTitle", "termsIntro", "termsSections"],
  },
  {
    id: "shipping",
    label: L("Shipping & returns page", "صفحة الشحن والاسترجاع"),
    fields: ["shippingEyebrow", "shippingTitle", "shippingIntro", "shippingSections"],
  },
];

// ============================================================================================
// Built-in text (the website's copy when the store has not changed a field)
// ============================================================================================

export interface ResolvedSiteText {
  texts: Record<SiteTextTextKey, string>;
  /** null = automatic promo messages from live settings. */
  announcements: string[] | null;
  faqItems: SiteTextFaqItem[];
  termsSections: SiteTextSection[];
  shippingSections: SiteTextSection[];
}

/**
 * Defaults for text fields. contactEmail / contactWhatsapp default to "" here: the Storefront falls back
 * to its deployment settings (STOREFRONT_SUPPORT_EMAIL / STOREFRONT_WHATSAPP_NUMBER) for those.
 */
export const SITE_TEXT_DEFAULTS: Readonly<Record<SiteTextTextKey, string>> = {
  storeName: "Zee Store",
  seoTitle: "{storeName} — Everyday fits, fresh drops",
  seoDescription: "Everyday fits with attitude — fresh drops and cash on delivery across Egypt.",
  newArrivalsEyebrow: "Just landed",
  newArrivalsTitle: "New arrivals",
  newArrivalsLink: "See all new",
  bestSellersEyebrow: "Most wanted",
  bestSellersTitle: "Best sellers",
  bestSellersLink: "Shop best sellers",
  featuredEyebrow: "Picked for you",
  featuredLink: "Shop all",
  collectionsEyebrow: "Drops & edits",
  collectionsTitle: "Shop the edits",
  collectionsLink: "All collections",
  brandNoteEyebrow: "{storeName}",
  brandNoteTitle: "Everyday menswear, minus the guesswork.",
  brandNoteBody:
    "Tees, shirts, denim and layers that work with what you already own. Check the size guide, order in a minute, and pay when it reaches your door.",
  brandNoteCtaLabel: "Shop everything",
  brandNoteCtaHref: "/catalog",
  newsletterEyebrow: "Drop alerts",
  newsletterTitle: "Be first to new drops.",
  newsletterBody: "New pieces and restocks, straight to your inbox. No spam, unsubscribe any time.",
  emptyStoreEyebrow: "Coming soon",
  emptyStoreTitle: "The first drop is on its way.",
  emptyStoreBody: "Sign up below and we’ll email you the moment it lands.",
  footerTagline: "Everyday fits with attitude. Fresh drops, cash on delivery across Egypt.",
  contactEmail: "",
  contactWhatsapp: "",
  contactHours: "Sun–Thu, 10:00–18:00 EET",
  contactEyebrow: "Contact",
  contactTitle: "We’d love to hear from you.",
  contactIntro:
    "Questions about an order, a piece, or sizing? Reach out and a real person will get back to you — usually within one business day.",
  contactOrderHelp:
    "Have your order number ready — it’s on your confirmation screen after checkout, and you can check where your order is any time on [Track your order](/track). Because we offer cash on delivery, you pay when your order arrives; contact us if you need to change an address or cancel before dispatch.",
  faqEyebrow: "Help",
  faqTitle: "Frequently asked questions.",
  faqIntro:
    "Everything you need to know about ordering with {storeName}. Still stuck? [Contact us](/contact).",
  termsEyebrow: "Legal",
  termsTitle: "Terms of service.",
  termsIntro:
    "The basics of shopping with {storeName}. By placing an order you agree to these terms.",
  shippingEyebrow: "Policies",
  shippingTitle: "Shipping & returns.",
  shippingIntro:
    "Clear, fair terms for getting your pieces to you — and sorting things out if they’re not quite right.",
};

export const SITE_TEXT_DEFAULT_FAQ: readonly SiteTextFaqItem[] = [
  {
    question: "Do I need an account to order?",
    answer:
      "No. {storeName} checkout is guest-first — add pieces to your cart and check out with just your delivery and contact details.",
  },
  {
    question: "How do I pay?",
    answer:
      "We offer cash on delivery: you pay when your order arrives. Your price and sizes are confirmed the moment you place the order.",
  },
  {
    question: "How is my cart saved?",
    answer:
      "Your cart is saved on this device, so it's still there if you close the page. Prices and stock are checked again at checkout, so you always order at the current price.",
  },
  {
    question: "When will my order ship?",
    answer:
      "Orders are typically prepared within 1–2 business days. Delivery timing depends on your governorate — see [shipping & returns](/shipping-returns) for details.",
  },
  {
    question: "Can I change or cancel my order?",
    answer:
      "If your order hasn't been dispatched yet, [contact us](/contact) with your order number and we'll do our best to help.",
  },
  {
    question: "What if a piece is out of stock at checkout?",
    answer:
      "Our online and in-store shoppers share the same stock, so popular pieces can sell out fast. If something sells out while it's in your cart, checkout tells you before your order is placed.",
  },
];

export const SITE_TEXT_DEFAULT_TERMS: readonly SiteTextSection[] = [
  {
    heading: "Orders & pricing",
    body: "All prices and availability shown are confirmed when you place an order. If a price or availability changes before your order is accepted, we’ll show it to you before anything is finalized.",
  },
  {
    heading: "Payment",
    body: "Orders on this website are paid by cash on delivery. You agree to pay the order total to the courier upon delivery.",
  },
  {
    heading: "Use of the site",
    body: "You agree to use this website lawfully and not to interfere with its operation or attempt to access data you’re not authorized to see.",
  },
  {
    heading: "Changes",
    body: "We may update these terms from time to time. Continued use of the website after changes take effect constitutes acceptance of the revised terms.",
  },
];

export const SITE_TEXT_DEFAULT_SHIPPING: readonly SiteTextSection[] = [
  {
    heading: "Shipping",
    body: "Orders are prepared within 1–2 business days. Delivery times vary by governorate; your courier will contact you to arrange drop-off. Because we offer cash on delivery, you can inspect your parcel and pay the courier on arrival.\n\n- Greater Cairo & Alexandria: typically 2–4 business days.\n- Other governorates: typically 3–6 business days.\n- You’ll get your order number on the confirmation screen at checkout.",
  },
  {
    heading: "Cash on delivery",
    body: "Payment is collected by the courier when your order is delivered. Please have the order total ready. If availability or price changes between adding to cart and checkout, we’ll show it to you before the order is confirmed.",
  },
  {
    heading: "Returns & exchanges",
    body: "{returnWindow}\n\n- Start a return on [Track your order](/track) with your order number and the phone you used at checkout. We’ll contact you to arrange a pickup.\n- Refunds are issued once we receive and inspect the returned items.",
  },
  {
    heading: "Need a hand?",
    body: "Our [support team](/contact) is happy to help with any shipping or returns question. You can also check the [FAQ](/faq).",
  },
];

export const SITE_TEXT_TEXT_KEYS = Object.keys(SITE_TEXT_DEFAULTS) as SiteTextTextKey[];

const fill = (value: string, storeName: string) => value.split("{storeName}").join(storeName);

/**
 * The website's text: each admin value, else the built-in default, with `{storeName}` filled in.
 * `{returnWindow}` is left for the Storefront (it needs the live return policy).
 */
export function resolveSiteText(document: SiteText | null | undefined): ResolvedSiteText {
  const doc = document ?? {};
  const storeName = doc.storeName ?? SITE_TEXT_DEFAULTS.storeName;
  const texts = {} as Record<SiteTextTextKey, string>;
  for (const key of SITE_TEXT_TEXT_KEYS)
    texts[key] = fill(doc[key] ?? SITE_TEXT_DEFAULTS[key], storeName);
  return {
    texts,
    announcements: doc.announcements ? doc.announcements.map((m) => fill(m, storeName)) : null,
    faqItems: (doc.faqItems ?? SITE_TEXT_DEFAULT_FAQ).map((item) => ({
      question: fill(item.question, storeName),
      answer: fill(item.answer, storeName),
    })),
    termsSections: (doc.termsSections ?? SITE_TEXT_DEFAULT_TERMS).map((s) => ({
      heading: fill(s.heading, storeName),
      body: fill(s.body, storeName),
    })),
    shippingSections: (doc.shippingSections ?? SITE_TEXT_DEFAULT_SHIPPING).map((s) => ({
      heading: fill(s.heading, storeName),
      body: fill(s.body, storeName),
    })),
  };
}

// ============================================================================================
// Body text: plain text → blocks (paragraphs, bullet lists, safe links)
// ============================================================================================

export type SiteTextInline =
  { type: "text"; text: string } | { type: "link"; text: string; href: string };
export type SiteTextBlock =
  { type: "paragraph"; inlines: SiteTextInline[] } | { type: "list"; items: SiteTextInline[][] };

/** Internal paths ("/catalog") or https links — the only hrefs the website will render. */
export const isSafeSiteHref = (href: string): boolean =>
  href === "/" || /^\/[^/]/.test(href) || /^https:\/\//.test(href);

export function parseSiteTextInlines(line: string): SiteTextInline[] {
  const out: SiteTextInline[] = [];
  const pattern = /\[([^\]\n]{1,200})\]\(([^)\s]{1,300})\)/g;
  let last = 0;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const [whole, label, href] = match as unknown as [string, string, string];
    if (match.index > last) out.push({ type: "text", text: line.slice(last, match.index) });
    out.push(
      isSafeSiteHref(href) ? { type: "link", text: label, href } : { type: "text", text: label },
    );
    last = match.index + whole.length;
  }
  if (last < line.length) out.push({ type: "text", text: line.slice(last) });
  return out;
}

/** Blank lines split paragraphs; consecutive "- " lines form a bullet list. */
export function parseSiteTextBody(body: string): SiteTextBlock[] {
  const blocks: SiteTextBlock[] = [];
  for (const chunk of body.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let paragraph: string[] = [];
    let list: SiteTextInline[][] = [];
    const flushParagraph = () => {
      if (paragraph.length)
        blocks.push({ type: "paragraph", inlines: parseSiteTextInlines(paragraph.join(" ")) });
      paragraph = [];
    };
    const flushList = () => {
      if (list.length) blocks.push({ type: "list", items: list });
      list = [];
    };
    for (const line of lines) {
      if (/^[-•]\s+/.test(line)) {
        flushParagraph();
        list.push(parseSiteTextInlines(line.replace(/^[-•]\s+/, "")));
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushList();
  }
  return blocks;
}

// ============================================================================================
// Editor form (Admin Mobile + POS)
// ============================================================================================

/**
 * Editor state. Text fields: "" = use the built-in text (shown as the placeholder). Lists: `null` = use
 * the built-in list; an array (even empty) = the store's own list.
 */
export interface SiteTextForm {
  texts: Record<SiteTextTextKey, string>;
  announcements: string[] | null;
  faqItems: SiteTextFaqItem[] | null;
  termsSections: SiteTextSection[] | null;
  shippingSections: SiteTextSection[] | null;
}

export function siteTextToForm(document: SiteText | null | undefined): SiteTextForm {
  const doc = document ?? {};
  const texts = {} as Record<SiteTextTextKey, string>;
  for (const key of SITE_TEXT_TEXT_KEYS) texts[key] = doc[key] ?? "";
  return {
    texts,
    announcements: doc.announcements ? [...doc.announcements] : null,
    faqItems: doc.faqItems ? doc.faqItems.map((i) => ({ ...i })) : null,
    termsSections: doc.termsSections ? doc.termsSections.map((s) => ({ ...s })) : null,
    shippingSections: doc.shippingSections ? doc.shippingSections.map((s) => ({ ...s })) : null,
  };
}

/** The built-in list an editor copies in when the owner switches a list to "custom". */
export function defaultSiteTextList(
  key: SiteTextListKey,
): string[] | SiteTextFaqItem[] | SiteTextSection[] {
  switch (key) {
    case "announcements":
      return ["Cash on delivery", "Delivery across Egypt", "New drops every season"];
    case "faqItems":
      return SITE_TEXT_DEFAULT_FAQ.map((i) => ({ ...i }));
    case "termsSections":
      return SITE_TEXT_DEFAULT_TERMS.map((s) => ({ ...s }));
    case "shippingSections":
      return SITE_TEXT_DEFAULT_SHIPPING.map((s) => ({ ...s }));
  }
}

export type SiteTextIssueCode =
  "too_long" | "too_many" | "item_required" | "unsafe_link" | "email_format" | "phone_format";
export interface SiteTextIssue {
  code: SiteTextIssueCode;
  max?: number;
  /** For list fields: the 0-based item with the problem. */
  index?: number;
}
export type SiteTextIssues = Partial<Record<SiteTextTextKey | SiteTextListKey, SiteTextIssue>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function validateSiteTextForm(form: SiteTextForm): SiteTextIssues {
  const issues: SiteTextIssues = {};
  for (const key of SITE_TEXT_TEXT_KEYS) {
    const def = SITE_TEXT_FIELDS[key];
    const value = form.texts[key].trim();
    if (!value) continue;
    if (value.length > def.max) issues[key] = { code: "too_long", max: def.max };
    else if (def.kind === "link" && !isSafeSiteHref(value)) issues[key] = { code: "unsafe_link" };
    else if (def.kind === "email" && !EMAIL.test(value)) issues[key] = { code: "email_format" };
    else if (def.kind === "phone" && !/^\d{8,15}$/u.test(value))
      issues[key] = { code: "phone_format" };
  }
  const checkList = <T>(key: SiteTextListKey, items: T[] | null, parts: (item: T) => string[]) => {
    if (!items) return;
    const def = SITE_TEXT_FIELDS[key];
    if (items.length > def.max) {
      issues[key] = { code: "too_many", max: def.max };
      return;
    }
    const limits = [def.itemMax?.a ?? Infinity, def.itemMax?.b ?? Infinity];
    items.some((item, index) =>
      parts(item).some((part, p) => {
        const value = part.trim();
        if (!value) issues[key] = { code: "item_required", index };
        else if (value.length > limits[p]!)
          issues[key] = { code: "too_long", max: limits[p], index };
        return issues[key] !== undefined;
      }),
    );
  };
  checkList("announcements", form.announcements, (m) => [m]);
  checkList("faqItems", form.faqItems, (i) => [i.question, i.answer]);
  checkList("termsSections", form.termsSections, (s) => [s.heading, s.body]);
  checkList("shippingSections", form.shippingSections, (s) => [s.heading, s.body]);
  return issues;
}

const ISSUE_TEXT: Readonly<Record<SiteTextIssueCode, Bilingual>> = {
  too_long: L("Keep it to {max} characters.", "الحد الأقصى {max} حرفًا."),
  too_many: L("Use at most {max} items.", "الحد الأقصى {max} عنصرًا."),
  item_required: L(
    "Item {n} is empty — fill it in or remove it.",
    "العنصر {n} فارغ — املأه أو احذفه.",
  ),
  unsafe_link: L(
    "Use an internal path such as /catalog, or an https:// link.",
    "استخدم مسارًا داخليًا مثل ‎/catalog‎ أو رابط ‎https://‎.",
  ),
  email_format: L("Enter a valid email address.", "أدخل بريدًا إلكترونيًا صحيحًا."),
  phone_format: L(
    "Digits only with the country code (8–15 digits).",
    "أرقام فقط مع كود الدولة (8–15 رقمًا).",
  ),
};

export function siteTextIssueMessage(issue: SiteTextIssue, language: SiteTextLanguage): string {
  let message = ISSUE_TEXT[issue.code][language]
    .replace("{max}", String(issue.max ?? ""))
    .replace("{n}", String((issue.index ?? 0) + 1));
  if (issue.index !== undefined && issue.code === "too_long")
    message = `${language === "ar" ? "العنصر" : "Item"} ${issue.index + 1}: ${message}`;
  return message;
}

/** The PUT body: trimmed values; blank text → null (built-in), lists as edited (null = built-in). */
export function buildSiteTextRequest(form: SiteTextForm): SiteText {
  const doc: Record<string, unknown> = {};
  for (const key of SITE_TEXT_TEXT_KEYS) {
    const value = form.texts[key].trim();
    doc[key] = value === "" ? null : value;
  }
  doc.announcements = form.announcements ? form.announcements.map((m) => m.trim()) : null;
  doc.faqItems = form.faqItems
    ? form.faqItems.map((i) => ({ question: i.question.trim(), answer: i.answer.trim() }))
    : null;
  doc.termsSections = form.termsSections
    ? form.termsSections.map((s) => ({ heading: s.heading.trim(), body: s.body.trim() }))
    : null;
  doc.shippingSections = form.shippingSections
    ? form.shippingSections.map((s) => ({ heading: s.heading.trim(), body: s.body.trim() }))
    : null;
  return doc as SiteText;
}

/** The placeholder an editor shows for an empty text field: the built-in text (store name filled). */
export function siteTextPlaceholder(key: SiteTextTextKey, form: SiteTextForm): string {
  const storeName = form.texts.storeName.trim() || SITE_TEXT_DEFAULTS.storeName;
  return fill(SITE_TEXT_DEFAULTS[key], storeName);
}

export function isSiteTextFormDirty(a: SiteTextForm, b: SiteTextForm): boolean {
  return JSON.stringify(buildSiteTextRequest(a)) !== JSON.stringify(buildSiteTextRequest(b));
}
