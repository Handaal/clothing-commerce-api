/**
 * Server-side helpers for turning raw database values into the external wire representation.
 *
 * Timestamps: PostgREST renders timestamptz in UTC with a +00:00 offset. We normalize the offset to a
 * trailing Z while PRESERVING full sub-second precision, so the same string is safe both as the external
 * ISO 8601 UTC value and as an exact keyset cursor boundary (millisecond truncation would corrupt
 * pagination). Integers: bigint columns may arrive as number or string; anything outside the JavaScript
 * safe-integer range fails safely rather than being silently truncated.
 */

export function normalizeTimestampUtc(dbValue: string): string {
  const parsed = new Date(dbValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Received an unparseable timestamp from the database.");
  }
  if (dbValue.endsWith("Z")) {
    return dbValue;
  }
  return dbValue.replace(/\+00:00$/, "Z");
}

export function toSafeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error("A numeric value is outside the supported application range.");
  }
  return parsed;
}
