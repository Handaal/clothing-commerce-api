import { describe, expect, it, vi } from "vitest";

import {
  ApiContractError,
  ApiHttpError,
  ApiNetworkError,
  createCommerceClient,
  SDK_VERSION,
} from "./index";

describe("Commerce SDK", () => {
  it("returns a validated health response and sends client metadata", async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(new Response(JSON.stringify({ status: "ok", version: "0.1.0" }))),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test/",
      client: { type: "pos-desktop", version: "0.1.0" },
      fetch: fetchImplementation,
    });

    await expect(client.getHealth()).resolves.toEqual({ status: "ok", version: "0.1.0" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Client-Type": "pos-desktop",
          "X-Client-Version": "0.1.0",
        }),
      }),
    );
  });

  it("rejects invalid successful responses with a typed error", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      fetch: async () => new Response(JSON.stringify({ status: "fine", version: 1 })),
    });

    await expect(client.getHealth()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("reports unavailable APIs with a typed network error", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      fetch: async () => Promise.reject(new Error("offline")),
    });

    await expect(client.getHealth()).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it("reports unsuccessful HTTP responses with the status", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      fetch: async () => new Response(null, { status: 503 }),
    });

    const request = client.getHealth();
    await expect(request).rejects.toBeInstanceOf(ApiHttpError);
    await expect(request).rejects.toMatchObject({ status: 503 });
  });

  it("exposes semantic SDK version metadata", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
