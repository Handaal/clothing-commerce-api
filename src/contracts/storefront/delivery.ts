import { z } from "zod";

import { CurrencySchema, NonNegativeIntegerSchema } from "../common/serialization";

/**
 * Storefront delivery areas and fees (Storefront program Phase 1B). A brand defines delivery zones (for
 * Egypt, the governorates: code "EG-C" = Cairo) each with a fee, plus an optional free-delivery threshold.
 * With at least one active zone, checkout requires `delivery.zoneCode` and charges that zone's fee (free
 * when the goods total after discount reaches the threshold). With no zones, delivery is free.
 */

export const DeliveryZoneCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/u, "Zone code must be letters, digits and hyphens.");

export const DeliveryZoneRefSchema = z.object({ code: z.string(), name: z.string() });
export type DeliveryZoneRef = z.infer<typeof DeliveryZoneRefSchema>;

/** Delivery part of a Storefront quote. `feeMinor` is null while a zone must still be chosen. */
export const StorefrontDeliveryQuoteSchema = z.object({
  required: z.boolean(),
  feeMinor: NonNegativeIntegerSchema.nullable(),
  zone: DeliveryZoneRefSchema.nullable(),
  freeDeliveryThresholdMinor: NonNegativeIntegerSchema.nullable(),
  /** True when the zone has a fee but the order qualifies for free delivery. */
  freeApplied: z.boolean(),
});
export type StorefrontDeliveryQuote = z.infer<typeof StorefrontDeliveryQuoteSchema>;

// ---- Public: delivery options for the Storefront ------------------------------------------------
export const PublicDeliveryOptionsSchema = z.object({
  /** Null when the brand has no Storefront checkout settings. */
  currency: CurrencySchema.nullable(),
  freeDeliveryThresholdMinor: NonNegativeIntegerSchema.nullable(),
  /** Active zones in display order; empty = delivery is free everywhere. */
  zones: z.array(
    z.object({ code: z.string(), name: z.string(), feeMinor: NonNegativeIntegerSchema }),
  ),
});
export type PublicDeliveryOptions = z.infer<typeof PublicDeliveryOptionsSchema>;

// ---- Management: delivery settings per brand (settings.read / settings.manage) -------------------
export const StorefrontDeliveryZoneSchema = z.object({
  code: z.string(),
  name: z.string(),
  feeMinor: NonNegativeIntegerSchema,
  active: z.boolean(),
  position: NonNegativeIntegerSchema,
});
export type StorefrontDeliveryZone = z.infer<typeof StorefrontDeliveryZoneSchema>;

export const StorefrontDeliverySettingsSchema = z.object({
  brandId: z.uuid(),
  currency: CurrencySchema,
  freeDeliveryThresholdMinor: NonNegativeIntegerSchema.nullable(),
  zones: z.array(StorefrontDeliveryZoneSchema),
});
export type StorefrontDeliverySettings = z.infer<typeof StorefrontDeliverySettingsSchema>;

export const UpdateStorefrontDeliveryRequestSchema = z
  .object({
    freeDeliveryThresholdMinor: NonNegativeIntegerSchema.max(100_000_000_000).nullable(),
    /** The complete zone list (replaces the current one). Codes are stored upper-case. */
    zones: z
      .array(
        z
          .object({
            code: DeliveryZoneCodeSchema,
            name: z.string().trim().min(1).max(100),
            feeMinor: NonNegativeIntegerSchema.max(100_000_000),
            active: z.boolean().optional(),
            position: NonNegativeIntegerSchema.max(1000).optional(),
          })
          .strict(),
      )
      .max(60)
      .refine(
        (zones) => new Set(zones.map((zone) => zone.code.toUpperCase())).size === zones.length,
        { message: "Zone codes must be unique." },
      ),
  })
  .strict();
export type UpdateStorefrontDeliveryRequest = z.infer<typeof UpdateStorefrontDeliveryRequestSchema>;
