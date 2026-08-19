import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";

import { generateOpenApiDocument } from "../src/openapi/document";

const outputDirectory = path.resolve("openapi");
await mkdir(outputDirectory, { recursive: true });
const document = await format(JSON.stringify(generateOpenApiDocument()), { parser: "json" });
await writeFile(path.join(outputDirectory, "openapi.json"), document, "utf8");
