import { z } from "zod";

/**
 * Opaque forward-pagination cursors. A cursor is base64url(JSON) with a version, a sort discriminator,
 * and the keyset values `k`. It is validated with Zod on decode; a malformed token, wrong version,
 * wrong sort, or wrong keys is rejected as INVALID_CURSOR (mapped to 400 by the route). Cursors are
 * NEVER signed or encrypted and carry NO authorization: every query re-applies tenant + visibility, so
 * the keyset only positions the scan and can never widen scope or cross a tenant.
 *
 * This module is server-only (it uses Node Buffer) and is deliberately not re-exported through the
 * SDK-facing contract barrel; the SDK treats `nextCursor` as an opaque string it echoes back.
 */

export class InvalidCursorError extends Error {
  constructor() {
    super("The provided pagination cursor is invalid.");
    this.name = "InvalidCursorError";
  }
}

const IsoDateTimeSchema = z.string().datetime();
const UuidSchema = z.string().uuid();

const ProductCursorSchema = z.object({
  v: z.literal(1),
  sort: z.literal("created_at_desc"),
  k: z.object({ createdAt: IsoDateTimeSchema, id: UuidSchema }),
});

const InventoryCursorSchema = z.object({
  v: z.literal(1),
  sort: z.literal("location_variant_asc"),
  k: z.object({ inventoryLocationId: UuidSchema, variantId: UuidSchema }),
});

const OrderCursorSchema = z.object({
  v: z.literal(1),
  sort: z.literal("placed_at_desc"),
  k: z.object({ placedAt: IsoDateTimeSchema, id: UuidSchema }),
});

const CustomerCursorSchema = z.object({
  v: z.literal(1),
  sort: z.literal("created_at_desc"),
  k: z.object({ createdAt: IsoDateTimeSchema, id: UuidSchema }),
});

export type ProductCursorKey = z.infer<typeof ProductCursorSchema>["k"];
export type InventoryCursorKey = z.infer<typeof InventoryCursorSchema>["k"];
export type OrderCursorKey = z.infer<typeof OrderCursorSchema>["k"];
export type CustomerCursorKey = z.infer<typeof CustomerCursorSchema>["k"];

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<Schema extends z.ZodTypeAny>(schema: Schema, cursor: string): z.infer<Schema> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new InvalidCursorError();
  }
  return result.data;
}

export function encodeProductCursor(key: ProductCursorKey): string {
  return encode({ v: 1, sort: "created_at_desc", k: key });
}

export function decodeProductCursor(cursor: string): ProductCursorKey {
  return decode(ProductCursorSchema, cursor).k;
}

export function encodeInventoryCursor(key: InventoryCursorKey): string {
  return encode({ v: 1, sort: "location_variant_asc", k: key });
}

export function decodeInventoryCursor(cursor: string): InventoryCursorKey {
  return decode(InventoryCursorSchema, cursor).k;
}

export function encodeOrderCursor(key: OrderCursorKey): string {
  return encode({ v: 1, sort: "placed_at_desc", k: key });
}

export function decodeOrderCursor(cursor: string): OrderCursorKey {
  return decode(OrderCursorSchema, cursor).k;
}

export function encodeCustomerCursor(key: CustomerCursorKey): string {
  return encode({ v: 1, sort: "created_at_desc", k: key });
}

export function decodeCustomerCursor(cursor: string): CustomerCursorKey {
  return decode(CustomerCursorSchema, cursor).k;
}
