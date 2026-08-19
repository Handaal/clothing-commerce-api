import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../src/openapi/document";

describe("OpenAPI contract", () => {
  it("matches the document derived from the Zod source", async () => {
    const persisted = JSON.parse(await readFile(path.resolve("openapi/openapi.json"), "utf8"));

    expect(persisted).toEqual(generateOpenApiDocument());
  });
});
