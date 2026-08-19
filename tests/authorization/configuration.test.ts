import { describe, expect, it } from "vitest";

import {
  readClerkVerifierConfiguration,
  readSupabasePrivilegedConfiguration,
} from "../../src/config/auth-environment";

describe("server-only authentication configuration", () => {
  it("validates and normalizes Clerk authorized parties", () => {
    expect(
      readClerkVerifierConfiguration({
        CLERK_SECRET_KEY: "sk_test_local",
        CLERK_PUBLISHABLE_KEY: "pk_test_local",
        CLERK_AUTHORIZED_PARTIES: "http://localhost:3000, https://admin.example.test",
      }),
    ).toEqual({
      secretKey: "sk_test_local",
      publishableKey: "pk_test_local",
      authorizedParties: ["http://localhost:3000", "https://admin.example.test"],
    });
  });

  it("fails closed when Clerk origins or privileged Supabase values are absent", () => {
    expect(() =>
      readClerkVerifierConfiguration({
        CLERK_SECRET_KEY: "sk_test_local",
        CLERK_PUBLISHABLE_KEY: "pk_test_local",
      }),
    ).toThrow();
    expect(() => readSupabasePrivilegedConfiguration({ SUPABASE_URL: "not-a-url" })).toThrow();
  });

  it("does not accept public-prefixed values as server credential substitutes", () => {
    expect(() =>
      readSupabasePrivilegedConfiguration({
        SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "must-not-be-used",
      }),
    ).toThrow();
  });
});
