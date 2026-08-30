import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { OPENAPI_DOCUMENT_PATH, renderOpenApiDocument } from "../src/openapi/render";

await mkdir(path.dirname(OPENAPI_DOCUMENT_PATH), { recursive: true });
await writeFile(OPENAPI_DOCUMENT_PATH, await renderOpenApiDocument(), "utf8");
