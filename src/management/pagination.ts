import type { Paginated } from "../contracts";

/**
 * Derives a page envelope from rows fetched with LIMIT (limit + 1). If more than `limit` rows came back
 * there is a further page, and the forward cursor is taken from the LAST KEPT row's keyset. Because the
 * repository always applies the tenant + visibility predicate before the LIMIT, `hasMore` and the cursor
 * describe only authorized rows.
 */
export function buildPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
  toCursor: (row: Row) => string,
): Paginated<Item> {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const items = kept.map(toItem);
  const nextCursor = hasMore && kept.length > 0 ? toCursor(kept[kept.length - 1]) : null;
  return { items, pageInfo: { nextCursor, hasMore } };
}

export function emptyPage<Item>(): Paginated<Item> {
  return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
}
