// Post-build sanitation. esbuild (via tsup) prefixes each bundled module with a `// <relative-path>`
// provenance comment, e.g. `// ../../src/contracts/products.ts`. The module CONTENT is fully inlined
// (no runtime import of the API source), but these comment breadcrumbs would still make the published
// tarball textually reference `../../src`. We remove exactly those banner lines so the distributed SDK
// is self-contained in both substance and text. Only leading `// ../` comment lines are stripped; all
// bundled code and real comments are preserved.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDirectory = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const bannerPattern = /^\/\/ \.\.\/.*\r?\n/gm;

for (const file of readdirSync(distDirectory)) {
  if (!/\.(c?js)$/.test(file)) {
    continue;
  }
  const path = join(distDirectory, file);
  const original = readFileSync(path, "utf8");
  const sanitized = original.replace(bannerPattern, "");
  if (sanitized !== original) {
    writeFileSync(path, sanitized);
  }
}
