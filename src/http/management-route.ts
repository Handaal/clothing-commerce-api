import { z } from "zod";

import type { AuthorizationContext } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import type { AuthorizationContextResolver } from "../authorization/context-resolver";
import type { ApiError, ApiErrorDetail } from "../contracts";
import { FulfillmentError } from "../fulfillments/errors";
import { InvalidCursorError } from "../management/cursor";
import { ManagementNotFoundError } from "../management/errors";
import { OrderError } from "../orders/errors";
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

function jsonResponse(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
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

function mapError(error: unknown, requestId: string): Response {
  if (error instanceof RequestValidationError) {
    return jsonResponse(
      400,
      errorBody("VALIDATION_ERROR", "The request is not valid.", requestId, error.issues),
      requestId,
    );
  }
  if (error instanceof InvalidCursorError) {
    return jsonResponse(400, errorBody("INVALID_CURSOR", error.message, requestId), requestId);
  }
  if (error instanceof AuthorizationError) {
    return jsonResponse(
      error.httpStatus,
      errorBody(error.code, error.message, requestId),
      requestId,
    );
  }
  if (error instanceof ManagementNotFoundError) {
    return jsonResponse(404, errorBody(error.code, error.message, requestId), requestId);
  }
  if (error instanceof OrderError || error instanceof FulfillmentError) {
    return jsonResponse(
      error.httpStatus,
      errorBody(error.code, error.message, requestId),
      requestId,
    );
  }
  // Unknown/internal (including ResponseContractError and any repository defect). Never leak details.
  return jsonResponse(
    500,
    errorBody("INTERNAL_ERROR", "An unexpected error occurred.", requestId),
    requestId,
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
export function managementOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
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
    return jsonResponse(200, validateResponse(options.responseSchema, value), requestId);
  } catch (error) {
    return mapError(error, requestId);
  }
}

/**
 * Runs an identity-only management route (the /me/tenants bootstrap): authenticates the identity WITHOUT
 * any tenant context and never reads X-Tenant-Id.
 */
export async function runIdentityManagementRoute<T>(options: {
  readonly responseSchema: z.ZodType<T>;
  readonly handler: (requestId: string) => Promise<T>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const value = await options.handler(requestId);
    return jsonResponse(200, validateResponse(options.responseSchema, value), requestId);
  } catch (error) {
    return mapError(error, requestId);
  }
}
