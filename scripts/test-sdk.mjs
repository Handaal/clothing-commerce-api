import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkManifest = JSON.parse(
  readFileSync(join(repositoryRoot, "packages", "sdk", "package.json"), "utf8"),
);
const version = sdkManifest.version;
const tarballName = `shifted-clothing-commerce-sdk-${version}.tgz`;
const tarballPath = join(repositoryRoot, "artifacts", tarballName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "none"}`,
    );
  }
  return result;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`SDK check failed: ${message}`);
  }
}

// 1. Types, build (banner-stripped), and unit tests (methods, token, headers, errors, pagination).
run("pnpm", ["--filter", "@shifted/clothing-commerce-sdk", "typecheck"]);
run("pnpm", ["--filter", "@shifted/clothing-commerce-sdk", "build"]);
run("pnpm", ["exec", "vitest", "run", "packages/sdk/src"]);

// 2. Pack the versioned tarball.
run("pnpm", ["sdk:pack"]);

// 3. Static tarball inspection: extract into an isolated temp dir with no repo resolution.
const workDirectory = mkdtempSync(join(tmpdir(), "sdk-tarball-"));
try {
  // Extract through a relative archive path so both GNU tar and Windows BSD tar avoid interpreting
  // the drive-letter colon as a remote-host separator.
  cpSync(tarballPath, join(workDirectory, tarballName));
  run("tar", ["-xzf", tarballName, "-C", workDirectory], { cwd: workDirectory });
  const packageDirectory = join(workDirectory, "package");

  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  assert(manifest.version === version, `packed version ${manifest.version} != ${version}`);
  // The public declarations (dist/index.d.ts) import zod, so the package MUST declare zod as a runtime
  // dependency; otherwise a strict consumer cannot resolve the SDK's types from the tarball alone.
  assert(
    manifest.dependencies?.zod !== undefined,
    "the SDK must declare zod as a runtime dependency (its public declarations import zod)",
  );

  const distDirectory = join(packageDirectory, "dist");
  const distFiles = readdirSync(distDirectory);
  for (const required of ["index.js", "index.cjs", "index.d.ts"]) {
    assert(distFiles.includes(required), `missing built artifact ${required}`);
  }

  for (const file of distFiles) {
    const contents = readFileSync(join(distDirectory, file), "utf8");
    assert(!contents.includes("../../src"), `${file} still references ../../src`);
    assert(!contents.includes("../../../src"), `${file} still references ../../../src`);
    assert(!contents.includes("workspace:"), `${file} still references a workspace dependency`);
  }
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}

// 4. AUTHORITATIVE hermeticity check: install ONLY the tarball into a genuinely isolated project (no repo
//    workspace, no repo node_modules resolution) and never install zod ourselves — it must arrive
//    transitively from the SDK's declared dependency. Then exercise ESM import, CJS require, and a STRICT
//    TypeScript typecheck with `skipLibCheck: false`, so a future missing declaration dependency fails.
const consumerDirectory = mkdtempSync(join(tmpdir(), "sdk-consumer-"));
try {
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify(
      { name: "sdk-consumer", version: "1.0.0", private: true, type: "module" },
      null,
      2,
    ),
  );
  cpSync(tarballPath, join(consumerDirectory, tarballName));
  run("npm", ["install", `./${tarballName}`, "--no-audit", "--no-fund"], {
    cwd: consumerDirectory,
  });

  // zod must have been installed TRANSITIVELY: we never requested it.
  assert(
    existsSync(join(consumerDirectory, "node_modules", "zod")),
    "zod was not installed transitively from the SDK tarball (missing runtime dependency)",
  );

  writeFileSync(
    join(consumerDirectory, "run.mjs"),
    [
      `import { createCommerceClient, SDK_VERSION, canonicalizeOfflineSaleCommand } from "@shifted/clothing-commerce-sdk";`,
      `const client = createCommerceClient({ baseUrl: "https://example.test" });`,
      `if (typeof client.checkout !== "function") throw new Error("checkout missing");`,
      `if (typeof client.withTenant !== "function") throw new Error("withTenant missing");`,
      `if (typeof client.withTenant("t").listSupplierReceipts !== "function") throw new Error("supplier history missing");`,
      `if (typeof canonicalizeOfflineSaleCommand !== "function") throw new Error("canonical signer missing");`,
      `process.stdout.write("ESM_OK " + SDK_VERSION + "\\n");`,
    ].join("\n"),
  );
  run("node", ["run.mjs"], { cwd: consumerDirectory });

  writeFileSync(
    join(consumerDirectory, "run.cjs"),
    [
      `const { createCommerceClient } = require("@shifted/clothing-commerce-sdk");`,
      `if (typeof createCommerceClient !== "function") throw new Error("cjs export missing");`,
      `if (typeof createCommerceClient({ baseUrl: "https://example.test" }).withTenant("t").createSupplier !== "function") throw new Error("supplier create missing");`,
      `process.stdout.write("CJS_OK\\n");`,
    ].join("\n"),
  );
  run("node", ["run.cjs"], { cwd: consumerDirectory });

  writeFileSync(
    join(consumerDirectory, "consumer.ts"),
    [
      `import {`,
      `  createCommerceClient,`,
      `  type MeContextResponse,`,
      `  type ProductListResponse,`,
      `  type OrderDetailResponse,`,
      `  type CheckoutRequest, type CheckoutResult, type CreateReturnInput, type ReturnDetailResponse,`,
      `  type Supplier, type CreateSupplierInput, type UpdateSupplierInput, type SupplierReceiptsResponse,`,
      `} from "@shifted/clothing-commerce-sdk";`,
      ``,
      `async function main(client = createCommerceClient({ baseUrl: "https://example.test" })) {`,
      `  const checkout: (input: CheckoutRequest & { idempotencyKey: string }) => Promise<CheckoutResult> = client.checkout;`,
      `  void checkout;`,
      `  const scoped = client.withTenant("t");`,
      `  const createSupplier: (input: CreateSupplierInput) => Promise<Supplier> = scoped.createSupplier;`,
      `  const updateSupplier: (input: UpdateSupplierInput) => Promise<Supplier> = scoped.updateSupplier;`,
      `  const history: SupplierReceiptsResponse = await scoped.listSupplierReceipts("s", { limit: 10 });`,
      `  void createSupplier; void updateSupplier; void history; void scoped.listSuppliers; void scoped.getSupplier;`,
      `  void scoped.receiveInventory({ variantId: "v", inventoryLocationId: "l", quantity: 1, supplierId: "s", supplierReference: "DN-1", idempotencyKey: "k" });`,
      `  const createReturn: (input: CreateReturnInput) => Promise<ReturnDetailResponse> = scoped.createReturn;`,
      `  void createReturn; void scoped.getReturnEligibility; void scoped.listReturns; void scoped.getReturn; void scoped.settleRefund;`,
      `  const context: MeContextResponse = await scoped.getContext();`,
      `  const promotionAccess: { canRead: boolean; canManage: boolean } | undefined = context.access.promotions;`,
      `  const products: ProductListResponse = await scoped.listProducts({ limit: 10 });`,
      `  const order: OrderDetailResponse = await scoped.getOrder("o");`,
      `  const posContext = await scoped.getPosContext();`,
      `  const createPosSale = scoped.createPosSale;`,
      `  const ingestOfflineSale = scoped.ingestOfflineSale;`,
      `  return { context, promotionAccess, products, order, posContext, createPosSale, ingestOfflineSale };`,
      `}`,
      `void main;`,
    ].join("\n"),
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    ),
  );
  // Run the repository's TypeScript against the isolated project. Module/type resolution roots at the
  // consumer directory (its own node_modules), so this proves the packed declarations resolve zod without
  // any API-repo resolution.
  const tscBin = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  run("node", [tscBin, "-p", "tsconfig.json"], { cwd: consumerDirectory });

  process.stdout.write(
    `\nSDK tarball ${tarballName} installs in isolation, imports (ESM + CJS), and strict-typechecks ` +
      `(skipLibCheck:false) with zod resolved transitively.\n`,
  );
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true });
}
