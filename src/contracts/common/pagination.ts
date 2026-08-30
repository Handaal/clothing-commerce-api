import { z } from "zod";

/**
 * The common pagination envelope. Lists never return a bare array; they wrap items with a `pageInfo`
 * carrying an opaque forward cursor. The cursor is a base64url JSON token (encoded/decoded server-side)
 * that carries only a sort discriminator and keyset values — never authorization. Every page re-applies
 * tenant + visibility, so a cursor can never widen a caller's scope or escape their tenant.
 */

export const PAGINATION_LIMIT_DEFAULT = 25;
export const PAGINATION_LIMIT_MIN = 1;
export const PAGINATION_LIMIT_MAX = 100;

export const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type PageInfo = z.infer<typeof PageInfoSchema>;

/** Builds a concrete `{ items, pageInfo }` schema for a given item schema. */
export function paginated<ItemSchema extends z.ZodTypeAny>(item: ItemSchema) {
  return z.object({
    items: z.array(item),
    pageInfo: PageInfoSchema,
  });
}

export type Paginated<Item> = {
  readonly items: readonly Item[];
  readonly pageInfo: PageInfo;
};
