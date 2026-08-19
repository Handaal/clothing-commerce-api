import { describe, expect, it } from "vitest";

import { HealthResponseSchema } from "../src/contracts";
import { getHealth } from "../src/health/get-health";

describe("health contract", () => {
  it("accepts a valid health response", () => {
    expect(HealthResponseSchema.parse({ status: "ok", version: "0.1.0" })).toEqual({
      status: "ok",
      version: "0.1.0",
    });
  });

  it("rejects an invalid health response", () => {
    expect(() => HealthResponseSchema.parse({ status: "degraded", version: "latest" })).toThrow();
  });

  it("uses a valid semantic API version", () => {
    expect(getHealth().version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
