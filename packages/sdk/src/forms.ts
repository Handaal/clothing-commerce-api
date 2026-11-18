import type {
  CreatePromotionRequest,
  PromotionDetail,
  UpdatePromotionRequest,
} from "../../../src/contracts/management/promotions";
import type {
  CreateSaleRequest,
  Sale,
  UpdateSaleRequest,
} from "../../../src/contracts/management/sales";
import type {
  StorefrontContent,
  UpdateStorefrontContentRequest,
} from "../../../src/contracts/management/storefront-content";

// Shared client-side form rules for the management channels (Admin Mobile, POS Website Management).
// Platform-neutral and language-neutral: validators return issue CODES, never sentences, and each app
// maps them to its own (translated) wording. Form state keeps raw input strings until the submit
// boundary; builders produce the SDK request DTOs. The Commerce API re-validates and owns every rule —
// these exist so both apps reject the same input the same way before a round trip.

// ============================================================================================
// Issues
// ============================================================================================

export type FormIssueCode =
  | "required"
  | "too_long"
  | "too_many"
  | "percent_range"
  | "amount_format"
  | "amount_too_large"
  | "amount_positive"
  | "amount_non_negative"
  | "whole_number"
  | "positive"
  | "quantity_range"
  | "currency_format"
  | "code_format"
  | "date_invalid"
  | "end_before_start"
  | "unsafe_link"
  | "link_required";

export interface FormIssue {
  code: FormIssueCode;
  /** Character limit (too_long) or item limit (too_many). */
  max?: number;
}

export type FormIssues<T> = Partial<Record<keyof T, FormIssue>>;

export const isFormIssue = (value: unknown): value is FormIssue =>
  typeof value === "object" && value !== null && "code" in value;

export const hasFormIssues = (issues: Record<string, FormIssue | undefined>): boolean =>
  Object.values(issues).some(Boolean);

/** The platform's single operating currency (inputs are locked to it). */
export const DEFAULT_FORM_CURRENCY = "EGP";

// ============================================================================================
// Parsers
// ============================================================================================

/** "12.5" → 1250 basis points (0.01–100%). */
export function parsePercentInput(value: string): number | FormIssue {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return { code: "percent_range" };
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints < 1 || basisPoints > 10_000) return { code: "percent_range" };
  return basisPoints;
}

/** Exact decimal → minor units. Blank → null. `allowZero` for minimums. */
export function parseMoneyInput(value: string, allowZero = false): number | FormIssue | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return { code: "amount_format" };
  const minor = Number(`${match[1]}${(match[2] ?? "").padEnd(2, "0")}`);
  if (!Number.isSafeInteger(minor)) return { code: "amount_too_large" };
  if (minor < 0 || (!allowZero && minor === 0)) {
    return { code: allowZero ? "amount_non_negative" : "amount_positive" };
  }
  return minor;
}

/** Blank → null; otherwise a positive whole number. */
export function parsePositiveIntegerInput(value: string): number | FormIssue | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return { code: "whole_number" };
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return { code: "positive" };
  return parsed;
}

/** Any `Date`-parseable text (ISO, or a `datetime-local` value in device time) → ISO instant. */
export function parseDateInput(value: string): { iso: string | null; invalid: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { iso: null, invalid: false };
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime())
    ? { iso: null, invalid: true }
    : { iso: date.toISOString(), invalid: false };
}

/** 2550 → "25.50". */
export function formatMinorInput(amountMinor: number): string {
  const negative = amountMinor < 0;
  const digits = Math.abs(Math.trunc(amountMinor)).toString().padStart(3, "0");
  const body = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return negative ? `-${body}` : body;
}

/** 1250 → "12.5%". */
export function formatPercentBasisPoints(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}

function windowIssues(startsAt: string, endsAt: string) {
  const issues: { startsAt?: FormIssue; endsAt?: FormIssue } = {};
  const starts = parseDateInput(startsAt);
  const ends = parseDateInput(endsAt);
  if (starts.invalid) issues.startsAt = { code: "date_invalid" };
  if (ends.invalid) issues.endsAt = { code: "date_invalid" };
  if (starts.iso && ends.iso && Date.parse(ends.iso) <= Date.parse(starts.iso)) {
    issues.endsAt = { code: "end_before_start" };
  }
  return issues;
}

const num = (value: number | FormIssue | null): number | null =>
  typeof value === "number" ? value : null;

// ============================================================================================
// Promotions
// ============================================================================================

export type PromotionLimitKind = "unlimited" | "single" | "custom";
export type PromotionChannelChoice = "all" | "pos" | "online";
export type PromotionTargetInput = NonNullable<CreatePromotionRequest["targets"]>[number];

export interface PromotionTargetChoice {
  target: PromotionTargetInput;
  label: string;
}

export interface PromotionFormState {
  name: string;
  description: string;
  benefitType: CreatePromotionRequest["benefitType"];
  benefitValue: string;
  buyQuantity: string;
  getQuantity: string;
  currency: string;
  targetType: CreatePromotionRequest["targetType"];
  activationType: CreatePromotionRequest["activationType"];
  minimumSubtotal: string;
  maximumDiscount: string;
  channel: PromotionChannelChoice;
  brandId: string;
  branchId: string;
  startsAt: string;
  endsAt: string;
  globalLimit: string;
  status: NonNullable<CreatePromotionRequest["status"]>;
  targets: PromotionTargetChoice[];
  initialCode: string;
  codeLimitKind: PromotionLimitKind;
  codeCustomLimit: string;
}

export type PromotionFormIssues = FormIssues<PromotionFormState>;

export const PROMOTION_LIMITS = { name: 200, description: 2000, code: 64 } as const;

export function emptyPromotionForm(currency = DEFAULT_FORM_CURRENCY): PromotionFormState {
  return {
    name: "",
    description: "",
    benefitType: "percentage",
    benefitValue: "",
    buyQuantity: "2",
    getQuantity: "1",
    currency,
    targetType: "order",
    activationType: "automatic",
    minimumSubtotal: "",
    maximumDiscount: "",
    channel: "all",
    brandId: "",
    branchId: "",
    startsAt: "",
    endsAt: "",
    globalLimit: "",
    status: "inactive",
    targets: [],
    initialCode: "",
    codeLimitKind: "unlimited",
    codeCustomLimit: "",
  };
}

/** Trimmed, upper-cased code, or an issue. Codes are A–Z, 0–9, `_` and `-` (max 64). */
export function normalizePromotionCode(value: string): string | FormIssue {
  const code = value.trim().toUpperCase();
  if (!code) return { code: "required" };
  if (code.length > PROMOTION_LIMITS.code || !/^[A-Z0-9_-]+$/.test(code)) {
    return { code: "code_format" };
  }
  return code;
}

/** Per-code redemption limit: null = unlimited. A blank custom limit is an issue. */
export function promotionCodeLimit(
  kind: PromotionLimitKind,
  customLimit: string,
): number | FormIssue | null {
  if (kind === "unlimited") return null;
  if (kind === "single") return 1;
  return parsePositiveIntegerInput(customLimit) ?? { code: "whole_number" };
}

export interface ValidatePromotionOptions {
  /**
   * Edit mode only: require `initialCode` (when switching an existing promotion to code activation and
   * it has no active code yet). Create mode always requires it for code activation.
   */
  requireInitialCode?: boolean;
}

export function validatePromotionForm(
  state: PromotionFormState,
  mode: "create" | "edit",
  options: ValidatePromotionOptions = {},
): PromotionFormIssues {
  const issues: PromotionFormIssues = {};
  const name = state.name.trim();
  if (!name) issues.name = { code: "required" };
  else if (name.length > PROMOTION_LIMITS.name) {
    issues.name = { code: "too_long", max: PROMOTION_LIMITS.name };
  }
  if (state.description.trim().length > PROMOTION_LIMITS.description) {
    issues.description = { code: "too_long", max: PROMOTION_LIMITS.description };
  }

  if (state.benefitType === "buy_x_get_y") {
    for (const key of ["buyQuantity", "getQuantity"] as const) {
      const value = state[key].trim();
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
        issues[key] = { code: "quantity_range" };
      }
    }
  } else if (state.benefitType === "percentage") {
    const value = parsePercentInput(state.benefitValue);
    if (isFormIssue(value)) issues.benefitValue = value;
  } else {
    const value = parseMoneyInput(state.benefitValue, false);
    if (value === null) issues.benefitValue = { code: "required" };
    else if (isFormIssue(value)) issues.benefitValue = value;
    if (!/^[A-Z]{3}$/.test(state.currency.trim().toUpperCase())) {
      issues.currency = { code: "currency_format" };
    }
  }

  const minimum = parseMoneyInput(state.minimumSubtotal, true);
  if (isFormIssue(minimum)) issues.minimumSubtotal = minimum;
  const maximum = parseMoneyInput(state.maximumDiscount, false);
  if (isFormIssue(maximum)) issues.maximumDiscount = maximum;
  const globalLimit = parsePositiveIntegerInput(state.globalLimit);
  if (isFormIssue(globalLimit)) issues.globalLimit = globalLimit;

  if (state.targetType === "variant_scope" && state.targets.length === 0) {
    issues.targets = { code: "required" };
  }

  const needsCode =
    state.activationType === "code" &&
    (mode === "create" || options.requireInitialCode === true || state.initialCode.trim() !== "");
  if (needsCode) {
    const code = normalizePromotionCode(state.initialCode);
    if (isFormIssue(code)) issues.initialCode = code;
    const limit = promotionCodeLimit(state.codeLimitKind, state.codeCustomLimit);
    if (isFormIssue(limit)) issues.codeCustomLimit = limit;
  }

  return { ...issues, ...windowIssues(state.startsAt, state.endsAt) };
}

/** The initial/added code for a code promotion, or null when none was entered. */
export function promotionInitialCode(
  state: PromotionFormState,
): { code: string; maxRedemptions: number | null } | null {
  if (state.activationType !== "code") return null;
  const code = normalizePromotionCode(state.initialCode);
  if (isFormIssue(code)) return null;
  return {
    code,
    maxRedemptions: num(promotionCodeLimit(state.codeLimitKind, state.codeCustomLimit)),
  };
}

type BenefitFields = Pick<
  CreatePromotionRequest,
  | "benefitType"
  | "benefitPercentBp"
  | "benefitAmountMinor"
  | "benefitCurrency"
  | "buyQuantity"
  | "getQuantity"
>;

function benefitFields(state: PromotionFormState): BenefitFields {
  if (state.benefitType === "buy_x_get_y") {
    return {
      benefitType: "buy_x_get_y",
      buyQuantity: Number(state.buyQuantity.trim()),
      getQuantity: Number(state.getQuantity.trim()),
    };
  }
  if (state.benefitType === "percentage") {
    return {
      benefitType: "percentage",
      benefitPercentBp: parsePercentInput(state.benefitValue) as number,
    };
  }
  return {
    benefitType: "fixed_amount",
    benefitAmountMinor: num(parseMoneyInput(state.benefitValue, false)) as number,
    benefitCurrency: state.currency.trim().toUpperCase(),
  };
}

const channelOf = (state: PromotionFormState): "pos" | "online" | null =>
  state.benefitType === "buy_x_get_y" ? "online" : state.channel === "all" ? null : state.channel;

export function buildCreatePromotionRequest(state: PromotionFormState): CreatePromotionRequest {
  const request: CreatePromotionRequest = {
    name: state.name.trim(),
    description: state.description.trim() || null,
    ...benefitFields(state),
    targetType: state.targetType,
    activationType: state.activationType,
    minSubtotalMinor: num(parseMoneyInput(state.minimumSubtotal, true)),
    maxDiscountMinor: num(parseMoneyInput(state.maximumDiscount, false)),
    startsAt: parseDateInput(state.startsAt).iso,
    endsAt: parseDateInput(state.endsAt).iso,
    channel: channelOf(state),
    brandId: state.brandId || null,
    branchId: state.branchId || null,
    globalRedemptionLimit: num(parsePositiveIntegerInput(state.globalLimit)),
    status: state.status,
  };
  if (state.targetType === "variant_scope") {
    request.targets = state.targets.map(({ target }) => target);
  }
  const code = promotionInitialCode(state);
  if (code) request.codes = [code];
  return request;
}

export function promotionTargetKey(target: PromotionTargetInput): string {
  return target.productId ? `p:${target.productId}` : `v:${target.variantId ?? ""}`;
}

function sameTargets(a: readonly PromotionTargetInput[], b: readonly PromotionTargetInput[]) {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(promotionTargetKey));
  return b.every((target) => keys.has(promotionTargetKey(target)));
}

/**
 * Every setting is editable (owner decision 2026-11-18). Name, description and schedule are always
 * sent; anything else only when it differs from `detail`. Switching the discount type sends the new
 * type with its fields. Codes are managed with createPromotionCode/setPromotionCodeStatus — see
 * `promotionInitialCode` for the code entered while switching to code activation.
 */
export function buildUpdatePromotionRequest(
  state: PromotionFormState,
  detail: PromotionDetail,
): UpdatePromotionRequest {
  const request: UpdatePromotionRequest = {
    name: state.name.trim(),
    description: state.description.trim() || null,
    startsAt: parseDateInput(state.startsAt).iso,
    endsAt: parseDateInput(state.endsAt).iso,
  };
  const benefit = benefitFields(state);
  if (benefit.benefitType !== detail.benefitType) {
    Object.assign(request, benefit);
  } else if (benefit.benefitType === "percentage") {
    if (benefit.benefitPercentBp !== detail.benefitPercentBp) {
      request.benefitPercentBp = benefit.benefitPercentBp;
    }
  } else if (benefit.benefitType === "fixed_amount") {
    if (benefit.benefitAmountMinor !== detail.benefitAmountMinor) {
      request.benefitAmountMinor = benefit.benefitAmountMinor;
    }
    if (benefit.benefitCurrency !== detail.benefitCurrency) {
      request.benefitCurrency = benefit.benefitCurrency;
    }
  } else {
    if (benefit.buyQuantity !== detail.buyQuantity) request.buyQuantity = benefit.buyQuantity;
    if (benefit.getQuantity !== detail.getQuantity) request.getQuantity = benefit.getQuantity;
  }

  const minSubtotalMinor = num(parseMoneyInput(state.minimumSubtotal, true));
  if (minSubtotalMinor !== detail.minSubtotalMinor) request.minSubtotalMinor = minSubtotalMinor;
  const maxDiscountMinor = num(parseMoneyInput(state.maximumDiscount, false));
  if (maxDiscountMinor !== detail.maxDiscountMinor) request.maxDiscountMinor = maxDiscountMinor;
  const channel = channelOf(state);
  if (channel !== detail.channel && state.benefitType !== "buy_x_get_y") request.channel = channel;
  const brandId = state.brandId || null;
  if (brandId !== detail.brandId) request.brandId = brandId;
  const branchId = state.branchId || null;
  if (branchId !== detail.branchId) request.branchId = branchId;
  const globalLimit = num(parsePositiveIntegerInput(state.globalLimit));
  if (globalLimit !== detail.globalRedemptionLimit) request.globalRedemptionLimit = globalLimit;
  if (state.activationType !== detail.activationType) {
    request.activationType = state.activationType;
  }
  if (state.targetType !== detail.targetType) request.targetType = state.targetType;
  if (state.targetType === "variant_scope") {
    const targets = state.targets.map(({ target }) => target);
    const current = detail.targets.map(({ productId, variantId }) => ({ productId, variantId }));
    if (state.targetType !== detail.targetType || !sameTargets(targets, current)) {
      request.targets = targets;
    }
  }
  return request;
}

/** "Linen Shirt" / "Linen Shirt · Medium" from a detail target's resolved names. */
export function promotionTargetLabel(target: PromotionDetail["targets"][number]): string {
  if (target.productId) return target.productName ?? target.productId;
  const variant = target.variantName ?? target.sku ?? target.variantId ?? "";
  return target.productName ? `${target.productName} · ${variant}` : variant;
}

export interface ToFormOptions {
  /** ISO instant → the app's date input value (defaults to the ISO string itself). */
  toDateInput?: (iso: string | null) => string;
  currency?: string;
}

export function promotionToForm(
  detail: PromotionDetail,
  options: ToFormOptions = {},
): PromotionFormState {
  const toDate = options.toDateInput ?? ((iso: string | null) => iso ?? "");
  return {
    ...emptyPromotionForm(options.currency),
    name: detail.name,
    description: detail.description ?? "",
    benefitType: detail.benefitType,
    benefitValue:
      detail.benefitType === "buy_x_get_y"
        ? ""
        : detail.benefitType === "percentage"
          ? formatPercentBasisPoints(detail.benefitPercentBp ?? 0).replace("%", "")
          : formatMinorInput(detail.benefitAmountMinor ?? 0),
    buyQuantity: String(detail.buyQuantity ?? 2),
    getQuantity: String(detail.getQuantity ?? 1),
    currency: detail.benefitCurrency ?? options.currency ?? DEFAULT_FORM_CURRENCY,
    targetType: detail.targetType,
    activationType: detail.activationType,
    minimumSubtotal:
      detail.minSubtotalMinor === null ? "" : formatMinorInput(detail.minSubtotalMinor),
    maximumDiscount:
      detail.maxDiscountMinor === null ? "" : formatMinorInput(detail.maxDiscountMinor),
    channel: detail.channel ?? "all",
    brandId: detail.brandId ?? "",
    branchId: detail.branchId ?? "",
    startsAt: toDate(detail.startsAt),
    endsAt: toDate(detail.endsAt),
    globalLimit: detail.globalRedemptionLimit === null ? "" : String(detail.globalRedemptionLimit),
    status: detail.status,
    targets: detail.targets.map((target) => ({
      target: { productId: target.productId, variantId: target.variantId },
      label: promotionTargetLabel(target),
    })),
  };
}

export type PromotionEffectiveState = "active" | "inactive" | "scheduled" | "expired" | "exhausted";

/** Persisted status is active/inactive; the window and remaining uses decide the rest. */
export function promotionEffectiveState(
  promotion: Pick<PromotionDetail, "status" | "startsAt" | "endsAt" | "remainingRedemptions">,
  now = new Date(),
): PromotionEffectiveState {
  if (promotion.status === "inactive") return "inactive";
  if (promotion.startsAt && Date.parse(promotion.startsAt) > now.getTime()) return "scheduled";
  if (promotion.endsAt && Date.parse(promotion.endsAt) <= now.getTime()) return "expired";
  if (promotion.remainingRedemptions === 0) return "exhausted";
  return "active";
}

// ============================================================================================
// Item sales
// ============================================================================================

export interface SaleFormState {
  name: string;
  benefitType: "percentage" | "fixed_amount";
  value: string;
  currency: string;
  scope: "all" | "collection" | "products";
  collectionId: string;
  productIds: string[];
  startsAt: string;
  endsAt: string;
  active: boolean;
}

export type SaleFormIssues = FormIssues<SaleFormState>;

export function emptySaleForm(currency = DEFAULT_FORM_CURRENCY): SaleFormState {
  return {
    name: "",
    benefitType: "percentage",
    value: "",
    currency,
    scope: "all",
    collectionId: "",
    productIds: [],
    startsAt: "",
    endsAt: "",
    active: true,
  };
}

export function validateSaleForm(state: SaleFormState): SaleFormIssues {
  const issues: SaleFormIssues = {};
  const name = state.name.trim();
  if (!name) issues.name = { code: "required" };
  else if (name.length > 200) issues.name = { code: "too_long", max: 200 };

  if (state.benefitType === "percentage") {
    const value = parsePercentInput(state.value);
    if (isFormIssue(value)) issues.value = value;
  } else {
    const value = parseMoneyInput(state.value, false);
    if (value === null) issues.value = { code: "required" };
    else if (isFormIssue(value)) issues.value = value;
  }
  if (state.scope === "collection" && !state.collectionId) {
    issues.collectionId = { code: "required" };
  }
  if (state.scope === "products" && state.productIds.length === 0) {
    issues.productIds = { code: "required" };
  }
  return { ...issues, ...windowIssues(state.startsAt, state.endsAt) };
}

function saleBenefit(state: SaleFormState) {
  return state.benefitType === "percentage"
    ? {
        benefitType: "percentage" as const,
        benefitPercentBp: parsePercentInput(state.value) as number,
      }
    : {
        benefitType: "fixed_amount" as const,
        benefitAmountMinor: num(parseMoneyInput(state.value, false)) as number,
        benefitCurrency: state.currency.trim().toUpperCase(),
      };
}

function saleScope(state: SaleFormState) {
  if (state.scope === "collection") {
    return { scope: "collection" as const, collectionId: state.collectionId };
  }
  if (state.scope === "products") {
    return { scope: "products" as const, productIds: [...state.productIds] };
  }
  return { scope: "all" as const };
}

export function buildCreateSaleRequest(state: SaleFormState): CreateSaleRequest {
  return {
    name: state.name.trim(),
    ...saleBenefit(state),
    ...saleScope(state),
    startsAt: parseDateInput(state.startsAt).iso,
    endsAt: parseDateInput(state.endsAt).iso,
    status: state.active ? "active" : "inactive",
  };
}

/** Full replacement of the editable fields (status has its own endpoint). */
export function buildUpdateSaleRequest(state: SaleFormState): UpdateSaleRequest {
  return {
    name: state.name.trim(),
    ...saleBenefit(state),
    ...saleScope(state),
    startsAt: parseDateInput(state.startsAt).iso,
    endsAt: parseDateInput(state.endsAt).iso,
  };
}

export function saleToForm(sale: Sale, options: ToFormOptions = {}): SaleFormState {
  const toDate = options.toDateInput ?? ((iso: string | null) => iso ?? "");
  return {
    name: sale.name,
    benefitType: sale.benefitType,
    value:
      sale.benefitType === "percentage"
        ? formatPercentBasisPoints(sale.benefitPercentBp ?? 0).replace("%", "")
        : formatMinorInput(sale.benefitAmountMinor ?? 0),
    currency: sale.benefitCurrency ?? options.currency ?? DEFAULT_FORM_CURRENCY,
    scope: sale.scope,
    collectionId: sale.collectionId ?? "",
    productIds: [...sale.productIds],
    startsAt: toDate(sale.startsAt),
    endsAt: toDate(sale.endsAt),
    active: sale.status === "active",
  };
}

/**
 * The price a shopper would see for a list price, mirroring the server rule (percentage floors the
 * discount; fixed never goes below zero). Display only — the API is authoritative.
 */
export function previewSalePrice(state: SaleFormState, listPriceMinor: number): number | null {
  if (state.benefitType === "percentage") {
    const bp = parsePercentInput(state.value);
    if (isFormIssue(bp)) return null;
    return listPriceMinor - Math.floor((listPriceMinor * bp) / 10_000);
  }
  const amount = num(parseMoneyInput(state.value, false));
  return amount === null ? null : Math.max(0, listPriceMinor - amount);
}

export type SaleLiveState = "live" | "scheduled" | "ended" | "paused";

export function saleLiveState(
  sale: Pick<Sale, "status" | "startsAt" | "endsAt">,
  now = new Date(),
): SaleLiveState {
  if (sale.status === "inactive") return "paused";
  if (sale.startsAt && Date.parse(sale.startsAt) > now.getTime()) return "scheduled";
  if (sale.endsAt && Date.parse(sale.endsAt) <= now.getTime()) return "ended";
  return "live";
}

// ============================================================================================
// Storefront home-page content
// ============================================================================================

export interface StorefrontContentForm {
  eyebrow: string;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
  image: { bucket: string; path: string } | null;
  imageAlt: string;
  featuredHeading: string;
  featuredProductIds: string[];
  featuredCollectionIds: string[];
}

export type StorefrontContentIssues = FormIssues<StorefrontContentForm>;

export const MAX_FEATURED_PRODUCTS = 24;
export const MAX_FEATURED_COLLECTIONS = 12;

export const STOREFRONT_CONTENT_LIMITS = {
  eyebrow: 80,
  title: 160,
  subtitle: 400,
  ctaLabel: 40,
  ctaHref: 300,
  imageAlt: 300,
  featuredHeading: 120,
} as const satisfies Partial<Record<keyof StorefrontContentForm, number>>;

export function contentToForm(content: StorefrontContent): StorefrontContentForm {
  return {
    eyebrow: content.hero.eyebrow ?? "",
    title: content.hero.title ?? "",
    subtitle: content.hero.subtitle ?? "",
    ctaLabel: content.hero.ctaLabel ?? "",
    ctaHref: content.hero.ctaHref ?? "",
    image: content.hero.image
      ? { bucket: content.hero.image.bucket, path: content.hero.image.path }
      : null,
    imageAlt: content.hero.image?.altText ?? "",
    featuredHeading: content.featuredHeading ?? "",
    featuredProductIds: [...content.featuredProductIds],
    featuredCollectionIds: [...content.featuredCollectionIds],
  };
}

/** A same-site path ("/", "/catalog") or an https:// link. */
export function isSafeCtaHref(href: string): boolean {
  return href === "/" || /^\/[^/]/.test(href) || /^https:\/\//.test(href);
}

export function validateContentForm(form: StorefrontContentForm): StorefrontContentIssues {
  const issues: StorefrontContentIssues = {};
  for (const [key, max] of Object.entries(STOREFRONT_CONTENT_LIMITS) as [
    keyof typeof STOREFRONT_CONTENT_LIMITS,
    number,
  ][]) {
    if (form[key].trim().length > max) issues[key] = { code: "too_long", max };
  }
  const href = form.ctaHref.trim();
  if (href && !isSafeCtaHref(href)) issues.ctaHref = { code: "unsafe_link" };
  if (form.ctaLabel.trim() && !href) issues.ctaHref = { code: "link_required" };
  if (form.featuredProductIds.length > MAX_FEATURED_PRODUCTS) {
    issues.featuredProductIds = { code: "too_many", max: MAX_FEATURED_PRODUCTS };
  }
  if (form.featuredCollectionIds.length > MAX_FEATURED_COLLECTIONS) {
    issues.featuredCollectionIds = { code: "too_many", max: MAX_FEATURED_COLLECTIONS };
  }
  return issues;
}

const text = (value: string) => value.trim() || null;

export function buildContentRequest(form: StorefrontContentForm): UpdateStorefrontContentRequest {
  return {
    hero: {
      eyebrow: text(form.eyebrow),
      title: text(form.title),
      subtitle: text(form.subtitle),
      ctaLabel: text(form.ctaLabel),
      ctaHref: text(form.ctaHref),
      image: form.image ? { ...form.image, altText: text(form.imageAlt) } : null,
    },
    featuredHeading: text(form.featuredHeading),
    featuredProductIds: [...form.featuredProductIds],
    featuredCollectionIds: [...form.featuredCollectionIds],
  };
}

/** Move one id within an ordered selection. Out-of-range moves are a no-op. */
export function moveSelection(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
