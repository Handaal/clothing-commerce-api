import { describe, expect, it } from "vitest";

import {
  assertLocalStatus,
  parseArgs,
  requireOptIn,
} from "../../scripts/provision-dev-commerce-fixture.mjs";

describe("dev commerce fixture guards", () => {
  it("parses --help and takes no other arguments", () => {
    expect(parseArgs([])).toEqual({ help: false });
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects unknown arguments rather than silently ignoring them", () => {
    expect(() => parseArgs(["--tenant", "prod"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--clerk-subject", "user_x"])).toThrow(/Unknown argument/);
  });

  it("(opt-in) fails without the explicit development opt-in", () => {
    expect(() => requireOptIn({})).toThrow(/COMMERCE_DEV_FIXTURES=1/);
    expect(() => requireOptIn({ COMMERCE_DEV_FIXTURES: "0" })).toThrow();
    expect(() => requireOptIn({ COMMERCE_DEV_FIXTURES: "1" })).not.toThrow();
  });

  it("(local-only) accepts a local Supabase target", () => {
    expect(assertLocalStatus({ API_URL: "http://127.0.0.1:54321" })).toBe("127.0.0.1");
    expect(assertLocalStatus({ API_URL: "http://localhost:54321" })).toBe("localhost");
  });

  it("(local-only) HARD FAILS on a non-local / remote Supabase target", () => {
    expect(() => assertLocalStatus({ API_URL: "https://abcdefgh.supabase.co" })).toThrow(
      /non-local/i,
    );
    expect(() => assertLocalStatus({ API_URL: "https://db.example.com:5432" })).toThrow(
      /non-local/i,
    );
    expect(() => assertLocalStatus({})).toThrow(/local Supabase API URL/i);
    expect(() => assertLocalStatus(null)).toThrow();
  });
});
