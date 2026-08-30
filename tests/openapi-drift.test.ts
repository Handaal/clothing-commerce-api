import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../src/openapi/document";
import { renderOpenApiDocument } from "../src/openapi/render";

/** Normalize EOLs so the formatting assertion is about Prettier structure, not git's autocrlf. */
function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

describe("OpenAPI contract", () => {
  it("matches the document derived from the Zod source", async () => {
    const persisted = JSON.parse(await readFile(path.resolve("openapi/openapi.json"), "utf8"));

    expect(persisted).toEqual(generateOpenApiDocument());
  });

  it("is the exact blob the production generator formats (catches formatting drift)", async () => {
    const persisted = await readFile(path.resolve("openapi/openapi.json"), "utf8");

    // The generator formats with the repository's real Prettier config; a config/generator formatting
    // drift (e.g. wrong printWidth) must fail HERE, before it reaches CI's format:check gate.
    expect(normalizeEol(persisted)).toBe(normalizeEol(await renderOpenApiDocument()));
  });
});
