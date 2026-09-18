import { describe, expect, it } from "vitest";

import { GET, OPTIONS } from "../app/api/v1/health/route";
import { HealthResponseSchema } from "../src/contracts";

describe("GET /api/v1/health", () => {
  it("returns a contract-valid response", async () => {
    const response = GET(new Request("http://localhost/api/v1/health"));

    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
      version: "0.1.0",
    });
  });

  it("supports browser preflight for client metadata", () => {
    const response = OPTIONS(new Request("http://localhost/api/v1/health", { method: "OPTIONS" }));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("X-Client-Type");
  });
});
