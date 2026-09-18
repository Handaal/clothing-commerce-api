import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationService } from "../../src/authorization/authorization-service";
import { AuthorizationError } from "../../src/authorization/errors";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";
import type { VerifiedExternalIdentity } from "../../src/authorization/model";
import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import { CatalogManagementService } from "../../src/catalog/catalog-management-service";
import { createSupabaseCatalogWriteRepository } from "../../src/catalog/supabase-catalog-write-repository";
import { StorefrontCatalogService } from "../../src/catalog/storefront-catalog-service";
import { createSupabaseStorefrontCatalogRepository } from "../../src/catalog/storefront-catalog-repository";
import {
  CreateMediaUploadIntentRequestSchema,
  CreateProductRequestSchema,
  CreateVariantRequestSchema,
  CreateVariantResponseSchema,
  MediaUploadIntentResponseSchema,
  ProductUpdatedResponseSchema,
  ProductWriteResponseSchema,
  PublicProductDetailResponseSchema,
  PublicProductListResponseSchema,
  PublishProductRequestSchema,
  PublishProductResponseSchema,
  RegisterProductMediaRequestSchema,
  RegisterProductMediaResponseSchema,
  SetProductStatusRequestSchema,
  SetVariantPriceRequestSchema,
  SetVariantPriceResponseSchema,
  UnpublishProductResponseSchema,
  UpdateProductRequestSchema,
  type CreateVariantResponse,
} from "../../src/contracts";
import {
  runTenantManagementBodyRoute,
  runTenantManagementWriteRoute,
} from "../../src/http/management-route";
import { runPublicReadRoute } from "../../src/http/public-route";

const url = process.env.MGMT_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("MGMT_TEST_SUPABASE_URL and MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY are required.");
}
const config = { url, serviceRoleKey };

const T1 = "ca7a1000-0000-4000-8000-000000000001";
const B1 = "ca7ab000-0000-4000-8000-0000000000b1";
const B2 = "ca7ab000-0000-4000-8000-0000000000b2";
const AUTHOR_PUBLISH = "clerk-2j-authorpublish";
const AUTHOR_ONLY = "clerk-2j-author";
const NO_CATALOG = "clerk-2j-nocatalog";

class FakeVerifier implements ExternalIdentityVerifier {
  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    const match = request.headers.get("Authorization")?.match(/^Bearer subject:(.+)$/);
    if (!match) {
      throw new AuthorizationError("UNAUTHENTICATED");
    }
    return { provider: "clerk", subject: match[1] };
  }
}

let resolver: AuthorizationContextResolver;
let catalog: CatalogManagementService;
let storefront: StorefrontCatalogService;

beforeAll(() => {
  const authRepository = createSupabaseAuthorizationRepository(config);
  resolver = new AuthorizationContextResolver(new FakeVerifier(), authRepository);
  const authorizationService = new AuthorizationService(authRepository);
  catalog = new CatalogManagementService(
    authorizationService,
    createSupabaseCatalogWriteRepository(config),
  );
  storefront = new StorefrontCatalogService(createSupabaseStorefrontCatalogRepository(config));
});

function req(
  subject: string | null,
  method: string,
  path: string,
  { idempotencyKey, body }: { idempotencyKey?: string; body?: unknown } = {},
): Request {
  const headers = new Headers();
  if (subject !== null) headers.set("Authorization", `Bearer subject:${subject}`);
  headers.set("X-Tenant-Id", T1);
  if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
  headers.set("Content-Type", "application/json");
  return new Request(`http://test${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function readJson(response: Response): Promise<{ status: number; json: unknown }> {
  return { status: response.status, json: await response.json() };
}

// A shared per-run product built up across the ordered scenarios below.
let productId: string;
let variantId: string;

describe("Phase 2J catalog management HTTP acceptance", () => {
  it("creates a product (author), returning draft/unpublished", async () => {
    const response = await runTenantManagementWriteRoute({
      request: req(AUTHOR_PUBLISH, "POST", "/api/v1/products", {
        idempotencyKey: "k-create",
        body: { brandId: B1, name: "Classic Tee", slug: "classic-tee", description: "A tee" },
      }),
      contextResolver: resolver,
      requestSchema: CreateProductRequestSchema,
      responseSchema: ProductWriteResponseSchema,
      handler: ({ context, body, idempotencyKey }) =>
        catalog.createProduct(context, idempotencyKey, {
          brandId: body.brandId,
          name: body.name,
          slug: body.slug,
          ...(body.description !== undefined ? { description: body.description } : {}),
        }),
    });
    const { status, json } = await readJson(response);
    expect(status).toBe(200);
    const parsed = ProductWriteResponseSchema.parse(json);
    expect(parsed.status).toBe("draft");
    expect(parsed.storefrontStatus).toBe("unpublished");
    productId = parsed.productId;
  });

  it("replays an idempotent create and rejects a conflicting one", async () => {
    const replay = await runCreate("k-create", {
      brandId: B1,
      name: "Classic Tee",
      slug: "classic-tee",
      description: "A tee",
    });
    expect(replay.status).toBe(200);
    expect(ProductWriteResponseSchema.parse(replay.json).productId).toBe(productId);

    const conflict = await runCreate("k-create", {
      brandId: B1,
      name: "Different",
      slug: "classic-tee",
    });
    expect(conflict.status).toBe(409);
  });

  it("denies a member without catalog.author", async () => {
    const response = await runCreate(
      "k-nc",
      { brandId: B1, name: "Nope", slug: "nope" },
      NO_CATALOG,
    );
    expect(response.status).toBe(403);
  });

  it("denies a cross-tenant brand write", async () => {
    const response = await runCreate("k-x", { brandId: B2, name: "Foreign", slug: "foreign" });
    expect(response.status).toBe(403);
  });

  it("creates a variant and sets a price", async () => {
    const variant = await runTenantManagementWriteRoute({
      request: req(AUTHOR_PUBLISH, "POST", `/api/v1/products/${productId}/variants`, {
        idempotencyKey: "k-variant",
        body: { sku: "TEE-BLK-M", displayName: "Black / M" },
      }),
      contextResolver: resolver,
      requestSchema: CreateVariantRequestSchema,
      responseSchema: CreateVariantResponseSchema,
      handler: ({ context, body, idempotencyKey }) =>
        catalog.createVariant(context, productId, idempotencyKey, {
          sku: body.sku,
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        }),
    });
    const parsedVariant = await readJson(variant);
    expect(parsedVariant.status).toBe(200);
    variantId = (parsedVariant.json as CreateVariantResponse).variantId;

    const price = await runTenantManagementWriteRoute({
      request: req(AUTHOR_PUBLISH, "PUT", `/api/v1/variants/${variantId}/price`, {
        idempotencyKey: "k-price",
        body: { currency: "USD", amountMinor: 2500 },
      }),
      contextResolver: resolver,
      requestSchema: SetVariantPriceRequestSchema,
      responseSchema: SetVariantPriceResponseSchema,
      handler: ({ context, body, idempotencyKey }) =>
        catalog.setVariantPrice(context, variantId, idempotencyKey, {
          currency: body.currency,
          amountMinor: body.amountMinor,
        }),
    });
    expect((await readJson(price)).status).toBe(200);
  });

  it("registers media via the authorized upload intent", async () => {
    const intentResponse = await runTenantManagementBodyRoute({
      request: req(AUTHOR_PUBLISH, "POST", `/api/v1/products/${productId}/media/upload-intent`, {
        body: { contentType: "image/webp" },
      }),
      contextResolver: resolver,
      requestSchema: CreateMediaUploadIntentRequestSchema,
      responseSchema: MediaUploadIntentResponseSchema,
      handler: ({ context, body }) =>
        catalog.createMediaUploadIntent(context, productId, { contentType: body.contentType }),
    });
    const intent = await readJson(intentResponse);
    expect(intent.status).toBe(200);
    const parsedIntent = MediaUploadIntentResponseSchema.parse(intent.json);
    // Server-controlled, tenant/product-scoped destination; the client never chooses it.
    expect(parsedIntent.bucket).toBe("product-media");
    expect(parsedIntent.path.startsWith(`${T1}/${productId}/`)).toBe(true);

    const registerResponse = await runTenantManagementWriteRoute({
      request: req(AUTHOR_PUBLISH, "POST", `/api/v1/products/${productId}/media`, {
        idempotencyKey: "k-media",
        body: {
          bucket: parsedIntent.bucket,
          path: parsedIntent.path,
          altText: "Front",
          isPrimary: true,
        },
      }),
      contextResolver: resolver,
      requestSchema: RegisterProductMediaRequestSchema,
      responseSchema: RegisterProductMediaResponseSchema,
      handler: ({ context, body, idempotencyKey }) =>
        catalog.registerMedia(context, productId, idempotencyKey, {
          bucket: body.bucket,
          path: body.path,
          ...(body.altText !== undefined ? { altText: body.altText } : {}),
          ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
        }),
    });
    const register = await readJson(registerResponse);
    expect(register.status).toBe(200);
    const registered = RegisterProductMediaResponseSchema.parse(register.json);
    expect(registered.mediaId).toBeTruthy();
    expect(registered.isPrimary).toBe(true);
  });

  it("denies publish to an author who lacks catalog.publish", async () => {
    await activate();
    const response = await publish(AUTHOR_ONLY, "k-pub-denied");
    expect(response.status).toBe(403);
  });

  it("publishes with catalog.publish and exposes it to the public storefront", async () => {
    const response = await publish(AUTHOR_PUBLISH, "k-pub");
    const published = await readJson(response);
    expect(published.status).toBe(200);
    expect(PublishProductResponseSchema.parse(published.json).storefrontStatus).toBe("published");

    const list = await publicList();
    expect(list.status).toBe(200);
    const products = PublicProductListResponseSchema.parse(list.json).products;
    expect(products.some((p) => p.id === productId)).toBe(true);

    const detail = await publicDetail("classic-tee");
    expect(detail.status).toBe(200);
    const product = PublicProductDetailResponseSchema.parse(detail.json);
    expect(product.variants[0]?.sku).toBe("TEE-BLK-M");
    expect(product.variants[0]?.prices[0]?.amountMinor).toBe(2500);
    expect(product.variants[0]?.inStock).toBe(false);
    expect(product.media[0]?.path.startsWith(`${T1}/${productId}/`)).toBe(true);
    // Internal fields never leak into the public projection.
    expect((product as unknown as Record<string, unknown>).status).toBeUndefined();
  });

  it("reflects a management update in the public projection", async () => {
    const update = await runTenantManagementWriteRoute({
      request: req(AUTHOR_PUBLISH, "PATCH", `/api/v1/products/${productId}`, {
        idempotencyKey: "k-update",
        body: { name: "Classic Tee v2", slug: "classic-tee-v2", description: "Updated" },
      }),
      contextResolver: resolver,
      requestSchema: UpdateProductRequestSchema,
      responseSchema: ProductUpdatedResponseSchema,
      handler: ({ context, body, idempotencyKey }) =>
        catalog.updateProduct(context, productId, idempotencyKey, {
          name: body.name,
          slug: body.slug,
          ...(body.description !== undefined ? { description: body.description } : {}),
        }),
    });
    expect((await readJson(update)).status).toBe(200);

    const detail = await publicDetail("classic-tee-v2");
    expect(detail.status).toBe(200);
    expect(PublicProductDetailResponseSchema.parse(detail.json).name).toBe("Classic Tee v2");
  });

  it("unpublishes: gone from public, canonical retained, no public leak", async () => {
    const unpublish = await runTenantManagementWriteRoute({
      request: req(AUTHOR_PUBLISH, "DELETE", `/api/v1/products/${productId}/publication`, {
        idempotencyKey: "k-unpub",
        body: {},
      }),
      contextResolver: resolver,
      requestSchema: PublishProductRequestSchema,
      responseSchema: UnpublishProductResponseSchema,
      handler: ({ context, idempotencyKey }) =>
        catalog.unpublishProduct(context, productId, idempotencyKey),
    });
    expect((await readJson(unpublish)).status).toBe(200);

    const list = await publicList();
    expect(
      PublicProductListResponseSchema.parse(list.json).products.some((p) => p.id === productId),
    ).toBe(false);

    // An unpublished product cannot leak through the public detail endpoint.
    const detail = await publicDetail("classic-tee-v2");
    expect(detail.status).toBe(404);

    // Canonical product is retained: it can be republished (proving it still exists and is active).
    const republish = await publish(AUTHOR_PUBLISH, "k-republish");
    expect((await readJson(republish)).status).toBe(200);
  });
});

// ---- helpers ----
async function runCreate(
  idempotencyKey: string,
  body: { brandId: string; name: string; slug: string; description?: string },
  subject: string = AUTHOR_PUBLISH,
) {
  const response = await runTenantManagementWriteRoute({
    request: req(subject, "POST", "/api/v1/products", { idempotencyKey, body }),
    contextResolver: resolver,
    requestSchema: CreateProductRequestSchema,
    responseSchema: ProductWriteResponseSchema,
    handler: ({ context, body: parsedBody, idempotencyKey: key }) =>
      catalog.createProduct(context, key, {
        brandId: parsedBody.brandId,
        name: parsedBody.name,
        slug: parsedBody.slug,
        ...(parsedBody.description !== undefined ? { description: parsedBody.description } : {}),
      }),
  });
  return readJson(response);
}

async function activate() {
  await runTenantManagementWriteRoute({
    request: req(AUTHOR_PUBLISH, "POST", `/api/v1/products/${productId}/status`, {
      idempotencyKey: "k-activate",
      body: { status: "active" },
    }),
    contextResolver: resolver,
    requestSchema: SetProductStatusRequestSchema,
    responseSchema: ProductWriteResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      catalog.setProductStatus(context, productId, idempotencyKey, { status: body.status }),
  });
}

async function publish(subject: string, idempotencyKey: string) {
  return runTenantManagementWriteRoute({
    request: req(subject, "POST", `/api/v1/products/${productId}/publication`, {
      idempotencyKey,
      body: {},
    }),
    contextResolver: resolver,
    requestSchema: PublishProductRequestSchema,
    responseSchema: PublishProductResponseSchema,
    handler: ({ context, idempotencyKey: key }) => catalog.publishProduct(context, productId, key),
  });
}

async function publicList() {
  const response = await runPublicReadRoute({
    request: new Request(`http://test/api/v1/storefront/products?tenantId=${T1}`),
    responseSchema: PublicProductListResponseSchema,
    handler: () => storefront.listPublishedProducts(T1, null, 50),
  });
  return readJson(response);
}

async function publicDetail(slug: string) {
  const response = await runPublicReadRoute({
    request: new Request(`http://test/api/v1/storefront/products/${slug}?tenantId=${T1}`),
    responseSchema: PublicProductDetailResponseSchema,
    handler: () => storefront.getPublishedProduct(T1, slug),
  });
  return readJson(response);
}
