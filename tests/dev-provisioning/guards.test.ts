import { describe, expect, it } from "vitest";

import {
  assertLocalStatus,
  parseArgs,
  requireClerkSubject,
  requireOptIn,
} from "../../scripts/provision-dev-identity.mjs";

describe("dev identity provisioning guards", () => {
  it("parses the clerk subject from either --flag value or --flag=value form", () => {
    expect(parseArgs(["--clerk-subject", "user_abc"])).toEqual({
      help: false,
      clerkSubject: "user_abc",
    });
    expect(parseArgs(["--clerk-subject=user_xyz"]).clerkSubject).toBe("user_xyz");
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("rejects unknown arguments rather than silently ignoring them", () => {
    expect(() => parseArgs(["--tenant", "prod"])).toThrow(/Unknown argument/);
  });

  it("(1) fails without the explicit development opt-in", () => {
    expect(() => requireOptIn({})).toThrow(/COMMERCE_DEV_PROVISIONING=1/);
    expect(() => requireOptIn({ COMMERCE_DEV_PROVISIONING: "0" })).toThrow();
    expect(() => requireOptIn({ COMMERCE_DEV_PROVISIONING: "1" })).not.toThrow();
  });

  it("(3) fails when the Clerk subject is missing or blank", () => {
    expect(() => requireClerkSubject(undefined)).toThrow(/--clerk-subject/);
    expect(() => requireClerkSubject("   ")).toThrow(/--clerk-subject/);
    expect(requireClerkSubject("  user_abc  ")).toBe("user_abc");
  });

  it("(2) accepts a local Supabase target", () => {
    expect(assertLocalStatus({ API_URL: "http://127.0.0.1:54321" })).toBe("127.0.0.1");
    expect(assertLocalStatus({ API_URL: "http://localhost:54321" })).toBe("localhost");
  });

  it("(2) HARD FAILS on a non-local / remote Supabase target", () => {
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
