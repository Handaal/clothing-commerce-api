import { z } from "zod";

import type { AuthorizationContext } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import type { AuthorizationContextResolver } from "../authorization/context-resolver";
import { CatalogError } from "../catalog/catalog-errors";
import type { ApiError, ApiErrorDetail } from "../contracts";
import { FulfillmentError } from "../fulfillments/errors";
import { InventoryError } from "../inventory/errors";
import { InvalidCursorError } from "../management/cursor";
import { ManagementNotFoundError } from "../management/errors";
import { OrderError } from "../orders/errors";
import { PosSaleError } from "../pos/errors";
import { OfflinePosError } from "../pos/offline-errors";
import { SupplierError } from "../suppliers/errors";
import { StaffError } from "../staff/errors";
import { ReturnError } from "../returns/errors";
import { PromotionError } from "../promotions/errors";
import { ReportingError } from "../reporting/errors";
import { corsHeaders } from "./cors";

/**
 * The single centralized management API boundary. Every management route runs through one of the two
 * runners below, which own request-id generation, tenant-header parsing, authorization-context
 * resolution, input/response validation, uniform error mapping, and the response headers (X-Request-Id,
 * Cache-Control: no-store, CORS). Route handlers contain no try/catch and no header wiring.
 */

/** A validation failure of the inbound request (query, path, or tenant header). Maps to 400. */
export class RequestValidationError extends Error {
  constructor(readonly issues: readonly ApiErrorDetail[]) {
    super("The request is not valid.");
    this.name = "RequestValidationError";
  }
}

/** A server-side violation of the external response contract. Maps to a safe 500 (never leaked). */
class ResponseContractError extends Error {
  constructor() {
    super("The response failed external contract validation.");
    this.name = "ResponseContractError";
  }
}

const TenantHeaderSchema = z.string().uuid();

// The platform idempotency mechanism for the write boundary: a required Idempotency-Key header. It is
// carried out-of-band (never in the body) so it stays out of the payload the ledger fingerprints, and is
// bounded so a key cannot become an unbounded storage/index burden. The domain normalizes it further
// (lower/btrim); same key + different body is rejected by the database as a 409 IDEMPOTENCY_CONFLICT.
const IdempotencyKeyHeaderSchema = z.string().trim().min(1).max(200);

/** Parses and validates a request payload (query/path), raising a 400-mapped error with safe details. */
export function parseRequest<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === "number" ? segment : String(segment),
        ),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function requireTenantId(request: Request): string {
  const header = request.headers.get("X-Tenant-Id");
  if (header === null || header.trim() === "") {
    throw new RequestValidationError([
      { path: ["X-Tenant-Id"], message: "The X-Tenant-Id header is required." },
    ]);
  }
  const parsed = TenantHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new RequestValidationError([
      { path: ["X-Tenant-Id"], message: "The X-Tenant-Id header must be a UUID." },
    ]);
  }
  return parsed.data;
}

export function requireIdempotencyKey(request: Request): string {
  const header = request.headers.get("Idempotency-Key");
  if (header === null || header.trim() === "") {
    throw new RequestValidationError([
      { path: ["Idempotency-Key"], message: "The Idempotency-Key header is required." },
    ]);
  }
  const parsed = IdempotencyKeyHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new RequestValidationError([
      {
        path: ["Idempotency-Key"],
        message: "The Idempotency-Key header must be 1 to 200 characters.",
      },
    ]);
  }
  return parsed.data;
}

/** Reads and validates a JSON request body. A missing/malformed body or a schema failure maps to 400. */
export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new RequestValidationError([
      { path: ["body"], message: "The request body must be valid JSON." },
    ]);
  }
  return parseRequest(schema, raw);
}

function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  request?: Request,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
  });
}

function errorBody(
  code: string,
  message: string,
  requestId: string,
  details?: readonly ApiErrorDetail[],
): ApiError {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details !== undefined ? { details: [...details] } : {}),
    },
  };
}

function mapError(error: unknown, requestId: string, request?: Request): Response {
  if (error instanceof RequestValidationError) {
    return jsonResponse(
      400,
      errorBody("VALIDATION_ERROR", "The request is not valid.", requestId, error.issues),
      requestId,
      request,
    );
  }
  if (error instanceof InvalidCursorError) {
    return jsonResponse(
      400,
      errorBody("INVALID_CURSOR", error.message, requestId),
      requestId,
      request,
    );
  }
  if (error instanceof AuthorizationError) {
    return jsonResponse(
      error.httpStatus,
      errorBody(error.code, error.message, requestId),
      requestId,
      request,
    );
  }
  if (error instanceof ManagementNotFoundError) {
    return jsonResponse(404, errorBody(error.code, error.message, requestId), requestId, request);
  }
  if (
    error instanceof OrderError ||
    error instanceof FulfillmentError ||
    error instanceof InventoryError ||
    error instanceof PosSaleError ||
    error instanceof OfflinePosError ||
    error instanceof CatalogError ||
    error instanceof ReturnError ||
    error instanceof SupplierError ||
    error instanceof StaffError ||
    error instanceof PromotionError ||
    error instanceof ReportingError
  ) {
    const details =
      error instanceof PosSaleError &&
      error.code === "PRICE_CHANGED" &&
      error.authoritativeTotalMinor !== undefined
        ? [
            {
              path: ["expectedTotalMinor"],
              message: "Refresh and reconfirm the authoritative total.",
              value: error.authoritativeTotalMinor,
            },
          ]
        : undefined;
    return jsonResponse(
      error.httpStatus,
      errorBody(error.code, error.message, requestId, details),
      requestId,
      request,
    );
  }
  // Unknown/internal (including ResponseContractError and any repository defect). Never leak details.
  return jsonResponse(
    500,
    errorBody("INTERNAL_ERROR", "An unexpected error occurred.", requestId),
    requestId,
    request,
  );
}

function validateResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ResponseContractError();
  }
  return result.data;
}

/** OPTIONS preflight response shared by every management route. */
export function managementOptionsResponse(request?: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Runs a tenant-scoped management route: requires and validates X-Tenant-Id, resolves the full
 * AuthorizationContext, invokes the handler, validates the response against its external contract, and
 * attaches the standard headers. All thrown errors are mapped to the frozen envelope.
 */
export async function runTenantManagementRoute<T>(options: {
  readonly request: Request;
  readonly contextResolver: AuthorizationContextResolver;
  readonly responseSchema: z.ZodType<T>;
  readonly handler: (context: AuthorizationContext, requestId: string) => Promise<T>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const requestedTenantId = requireTenantId(options.request);
    const context = await options.contextResolver.resolve({
      request: options.request,
      requestedTenantId,
    });
    const value = await options.handler(context, requestId);
    return jsonResponse(
      200,
      validateResponse(options.responseSchema, value),
      requestId,
      options.request,
    );
  } catch (error) {
    return mapError(error, requestId, options.request);
  }
}

/** Builds a downloadable document response (e.g. CSV) with the standard headers plus Content-Disposition. */
function documentResponse(
  document: { readonly body: string; readonly filename: string; readonly mediaType: string },
  requestId: string,
  request?: Request,
): Response {
  return new Response(document.body, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      // Let browser clients read the filename cross-origin (native clients read it unconditionally).
      "Access-Control-Expose-Headers": "X-Request-Id, Content-Disposition",
      "Content-Type": `${document.mediaType}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${document.filename}"`,
      "X-Request-Id": requestId,
    },
  });
}

/**
 * Runs a tenant-scoped management route that streams a generated DOCUMENT (e.g. a CSV export) rather than
 * a JSON DTO: it requires and validates X-Tenant-Id, resolves the full AuthorizationContext, invokes the
 * handler, and returns the document with the correct Content-Type/Content-Disposition. Errors map to the
 * SAME frozen JSON envelope as every other route, so a failed export is a normal typed API error.
 */
export async function runTenantManagementDocumentRoute(options: {
  readonly request: Request;
  readonly contextResolver: AuthorizationContextResolver;
  readonly handler: (
    context: AuthorizationContext,
    requestId: string,
  ) => Promise<{ readonly body: string; readonly filename: string; readonly mediaType: string }>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const requestedTenantId = requireTenantId(options.request);
    const context = await options.contextResolver.resolve({
      request: options.request,
      requestedTenantId,
    });
    const document = await options.handler(context, requestId);
    return documentResponse(document, requestId, options.request);
  } catch (error) {
    return mapError(error, requestId, options.request);
  }
}

/**
 * Runs a tenant-scoped management WRITE route: requires and validates X-Tenant-Id and the
 * Idempotency-Key header, resolves the full AuthorizationContext, parses and validates the JSON body,
 * invokes the handler (which delegates to the existing domain service — authorization, scope, lifecycle,
 * and ledger rules all live there), validates the response contract, and attaches the standard headers.
 * The tenant, actor membership, and idempotency key are supplied to the handler; route handlers contain
 * no try/catch, no authorization logic, and no inventory SQL.
 */
export async function runTenantManagementWriteRoute<TBody, TResult>(options: {
  readonly request: Request;
  readonly contextResolver: AuthorizationContextResolver;
  readonly requestSchema: z.ZodType<TBody>;
  readonly responseSchema: z.ZodType<TResult>;
  readonly handler: (input: {
    readonly context: AuthorizationContext;
    readonly body: TBody;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }) => Promise<TResult>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const requestedTenantId = requireTenantId(options.request);
    const idempotencyKey = requireIdempotencyKey(options.request);
    const context = await options.contextResolver.resolve({
      request: options.request,
      requestedTenantId,
    });
    const body = await parseJsonBody(options.request, options.requestSchema);
    const value = await options.handler({ context, body, idempotencyKey, requestId });
    return jsonResponse(
      200,
      validateResponse(options.responseSchema, value),
      requestId,
      options.request,
    );
  } catch (error) {
    return mapError(error, requestId, options.request);
  }
}

/**
 * Runs a tenant-scoped management route that parses a JSON body but is NOT an idempotent mutation (for
 * example minting an upload intent): it requires and validates X-Tenant-Id, resolves the full
 * AuthorizationContext, parses/validates the body, and validates the response. No Idempotency-Key is
 * required because the operation performs no durable state change of its own.
 */
export async function runTenantManagementBodyRoute<TBody, TResult>(options: {
  readonly request: Request;
  readonly contextResolver: AuthorizationContextResolver;
  readonly requestSchema: z.ZodType<TBody>;
  readonly responseSchema: z.ZodType<TResult>;
  readonly handler: (input: {
    readonly context: AuthorizationContext;
    readonly body: TBody;
    readonly requestId: string;
  }) => Promise<TResult>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const requestedTenantId = requireTenantId(options.request);
    const context = await options.contextResolver.resolve({
      request: options.request,
      requestedTenantId,
    });
    const body = await parseJsonBody(options.request, options.requestSchema);
    const value = await options.handler({ context, body, requestId });
    return jsonResponse(
      200,
      validateResponse(options.responseSchema, value),
      requestId,
      options.request,
    );
  } catch (error) {
    return mapError(error, requestId, options.request);
  }
}

/** Device-authorized write boundary. It validates tenant, permanent sync key, body, and response,
 * but deliberately does not require a live human browser session. */
export async function runTenantDeviceWriteRoute<TBody, TResult>(options: {
  readonly request: Request;
  readonly requestSchema: z.ZodType<TBody>;
  readonly responseSchema: z.ZodType<TResult>;
  readonly handler: (input: {
    readonly tenantId: string;
    readonly body: TBody;
    readonly idempotencyKey: string;
  }) => Promise<TResult>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const tenantId = requireTenantId(options.request);
    const idempotencyKey = requireIdempotencyKey(options.request);
    const body = await parseJsonBody(options.request, options.requestSchema);
    const value = await options.handler({ tenantId, body, idempotencyKey });
    return jsonResponse(
      200,
      validateResponse(options.responseSchema, value),
      requestId,
      options.request,
    );
  } catch (error) {
    return mapError(error, requestId, options.request);
  }
}

/**
 * Runs an identity-only management route (the /me/tenants bootstrap): authenticates the identity WITHOUT
 * any tenant context and never reads X-Tenant-Id.
 */
export async function runIdentityManagementRoute<T>(options: {
  readonly request?: Request;
  readonly responseSchema: z.ZodType<T>;
  readonly handler: (requestId: string) => Promise<T>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const value = await options.handler(requestId);
    return jsonResponse(
      200,
      validateResponse(options.responseSchema, value),
      requestId,
      options.request,
    );
  } catch (error) {
    return mapError(error, requestId, options.request);
  }
}
