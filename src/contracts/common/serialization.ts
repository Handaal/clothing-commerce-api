import { z } from "zod";

/**
 * External serialization primitives shared by every management DTO. The wire types are deliberately
 * narrow: money and quantities are JSON numbers constrained to the JavaScript safe-integer range (the
 * database stores bigint; a value outside this range fails safely at the application boundary rather
 * than being silently truncated), and all timestamps are ISO 8601 UTC strings (never Date objects).
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** A signed JSON integer guaranteed to round-trip without precision loss. */
export const SafeIntegerSchema = z
  .number()
  .int()
  .min(-MAX_SAFE)
  .max(MAX_SAFE)
  .refine(Number.isSafeInteger, "Expected a JavaScript safe integer");

/** A non-negative safe integer, used for money (minor units) and on-hand quantities. */
export const NonNegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SAFE)
  .refine(Number.isSafeInteger, "Expected a non-negative JavaScript safe integer");

/** A strictly positive safe integer, used for ordered/fulfilled line quantities. */
export const PositiveIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_SAFE)
  .refine(Number.isSafeInteger, "Expected a positive JavaScript safe integer");

/** ISO 8601 UTC timestamp (e.g. 2026-08-30T12:00:00.000Z). */
export const IsoDateTimeSchema = z.string().datetime();

/** A three-letter uppercase ISO 4217 currency code. */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
