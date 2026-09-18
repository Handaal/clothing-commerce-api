import { z } from "zod";

import { CatalogError } from "../catalog/catalog-errors";
import type { ApiError } from "../contracts";
import { corsHeaders } from "./cors";
import { RequestValidationError } from "./management-route";

/**
 * The public Storefront read boundary runner. Unlike the management runners it requires NO session and
 * NO X-Tenant-Id header: the Storefront is an unauthenticated public consumer. The tenant/brand it
 * serves is supplied as explicit request parameters, and the underlying `catalog_public` functions are
 * published-only by construction, so no unpublished or internal data can be returned. Handlers contain
 * no try/catch and no header wiring.
 */
function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  request: Request,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
      "Cache-Control": "no-store",
    },
  });
}

function errorBody(code: string, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } };
}

function mapError(error: unknown, requestId: string, request: Request): Response {
  if (error instanceof RequestValidationError) {
    return jsonResponse(
      400,
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The request is not valid.",
          requestId,
          details: [...error.issues],
        },
      },
      requestId,
      request,
    );
  }
  if (error instanceof CatalogError) {
    return jsonResponse(
      error.httpStatus,
      errorBody(error.code, error.message, requestId),
      requestId,
      request,
    );
  }
  return jsonResponse(
    500,
    errorBody("INTERNAL_ERROR", "An unexpected error occurred.", requestId),
    requestId,
    request,
  );
}

export function publicOptionsResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function runPublicReadRoute<T>(options: {
  readonly request: Request;
  readonly responseSchema: z.ZodType<T>;
  readonly handler: (request: Request, requestId: string) => Promise<T>;
}): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const value = await options.handler(options.request, requestId);
    const validated = options.responseSchema.safeParse(value);
    if (!validated.success) {
      return jsonResponse(
        500,
        errorBody("INTERNAL_ERROR", "An unexpected error occurred.", requestId),
        requestId,
        options.request,
      );
    }
    return jsonResponse(200, validated.data, requestId, options.request);
  } catch (error) {
    return mapError(error, requestId, options.request);
  }
}
