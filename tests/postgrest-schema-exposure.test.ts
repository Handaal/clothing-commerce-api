import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const intendedPostgrestSchemas = [
  "public",
  "inventory_private",
  "orders_private",
  "fulfillments_private",
  "pos_sales_private",
  "offline_pos_private",
  "catalog_private",
  "catalog_public",
  "online_private",
  "returns_private",
  "suppliers_private",
  "customers_ar_private",
  "staff_private",
  "attendance_private",
  "promotions_private",
  "reporting_private",
  "settings_private",
] as const;

describe("local PostgREST schema exposure", () => {
  it("exposes exactly the schemas intentionally used by API repositories", async () => {
    const configuration = await readFile("supabase/config.toml", "utf8");
    const schemasLine = configuration.match(/^schemas\s*=\s*\[(.*)\]\s*$/mu)?.[1];

    expect(schemasLine, "[api].schemas must be present in supabase/config.toml").toBeDefined();
    const configured = [...(schemasLine?.matchAll(/"([a-z][a-z0-9_]*)"/gu) ?? [])].map(
      (match) => match[1],
    );

    expect(configured).toEqual(intendedPostgrestSchemas);
  });
});
