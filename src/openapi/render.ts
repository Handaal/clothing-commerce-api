import path from "node:path";
import { format, resolveConfig } from "prettier";

import { generateOpenApiDocument } from "./document";

/**
 * The canonical on-disk location of the generated OpenAPI document.
 */
export const OPENAPI_DOCUMENT_PATH = path.resolve("openapi/openapi.json");

/**
 * The single source of truth for the SERIALIZED OpenAPI document: the generated object rendered as JSON
 * and formatted with the repository's OWN Prettier configuration (resolved from `.prettierrc`). The
 * generator script and the drift test both consume this function, so the committed openapi/openapi.json
 * can never diverge in formatting from what CI's `format:check` expects. `resolveConfig` returning null
 * (no config found) falls back to Prettier defaults.
 */
export async function renderOpenApiDocument(): Promise<string> {
  const prettierConfig = await resolveConfig(OPENAPI_DOCUMENT_PATH);
  return format(JSON.stringify(generateOpenApiDocument()), {
    ...(prettierConfig ?? {}),
    parser: "json",
  });
}
