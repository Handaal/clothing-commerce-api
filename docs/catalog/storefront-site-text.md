# Storefront site text (SDK 0.52)

## Purpose

Store owners edit **every piece of website copy** that is not a product or the home hero, from Admin
Mobile (Website → Site text) or the POS (Website Management → Site text), without a code change or deploy:

- store name, search-engine/share title and description;
- promo bar messages (or the automatic live ones, or none);
- home section labels, titles and link texts; the empty-store message; the brand note (with its button);
  the drop-alert sign-up box;
- footer tagline;
- contact email, WhatsApp number, opening hours and the Contact page text;
- the FAQ, Terms and Shipping & returns pages (title, intro, and their questions / sections).

The **layout stays code**: which sections exist, their order and styling belong to the Storefront.

## How it works

- **One document per tenant**: `public.storefront_site_text (tenant_id, document jsonb)`, migration
  `20261124120000_storefront_site_text.sql`. Deny-by-default RLS; the API reads/writes only through
  `catalog_private.storefront_site_text_detail`, `upsert_storefront_site_text` and
  `public_storefront_site_text` (active tenants only). The DB enforces "object" + a 128 KiB ceiling.
- **The shape is the Zod contract** `src/contracts/storefront/site-text.ts` (`SiteTextSchema`, strict:
  known keys, lengths, safe links, email, WhatsApp digits). Every key is optional; missing/null = the
  Storefront's built-in text. Lists: `null` = built-in, `[]` = deliberately empty (e.g. no promo bar).
  The service drops nulls before storing.
- **Endpoints**: `GET/PUT /api/v1/storefront-site-text` (tenant-wide `catalog.author`, PUT is the whole
  document with `Idempotency-Key`); public `GET /api/v1/storefront/site-text?tenantId=`. A stored document
  that no longer parses is served as `{}` so the website never breaks.
- **SDK** (`packages/sdk/src/site-text.ts`) is the single definition for all three channels:
  `SITE_TEXT_GROUPS` / `SITE_TEXT_FIELDS` (editor sections and fields with English + Arabic labels and
  hints), `SITE_TEXT_DEFAULTS` + default FAQ/Terms/Shipping lists (the built-in copy), `resolveSiteText`
  (admin value else default, `{storeName}` filled), `parseSiteTextBody` (plain text → paragraphs,
  "- " bullets, `[label](/path|https://…)` links; anything else stays text), and the editor helpers
  `siteTextToForm` / `validateSiteTextForm` / `siteTextIssueMessage` / `buildSiteTextRequest`.
  Labels live in the SDK (unlike other forms' language-neutral codes) because the field list is long and
  must stay identical in both apps.
- **Storefront** loads it once per request (`src/storefront/site-text.ts`, 60 s revalidate) and renders
  body text with `SiteTextBody` (no HTML, only safe links). `{returnWindow}` on the Shipping page is the
  live return-window sentence. Contact email/WhatsApp fall back to `STOREFRONT_SUPPORT_EMAIL` /
  `STOREFRONT_WHATSAPP_NUMBER` when the store has not set them.

## Testing

- Contract/SDK unit tests: `packages/sdk/src/site-text.test.ts` (catalog covers every contract key, defaults
  satisfy the contract, parsing, validation).
- HTTP: `pnpm test:website:http` (M12–M14: empty document, every field kind round-trips, invalid values and
  unauthorized operators refused).
- Cross-channel: from this repo,
  `node scripts/test-offline-pos-http-isolated.mjs --dir tests/website-management-http --exec ../website-site-text-acceptance.mjs`
  drives the real Admin Mobile screen, then the real POS Website desk, then starts the real Storefront and
  checks the rendered pages (workspace-root script, not part of this repo).

## Limitations

- Website copy is single-language (English) today; the editor labels are bilingual, the content is not.
- Last save wins if two people edit at the same time (no version check), like the home-page content.
- Changes reach the website within the 60 s cache window.
