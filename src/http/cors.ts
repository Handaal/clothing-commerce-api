// Browser/Electron origins are an explicit allowlist. Native clients do not send Origin and do not
// need Access-Control-Allow-Origin. A disallowed browser origin receives no allow-origin header, so
// the browser blocks it; credentials and wildcard origins are never enabled.
const allowedHeaders =
  "Accept, Authorization, Content-Type, Idempotency-Key, X-Tenant-Id, X-Client-Type, X-Client-Version";

function configuredOrigins(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<string> {
  return new Set(
    (environment.COMMERCE_CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== "" && origin !== "*"),
  );
}

export function corsHeaders(
  request?: Request,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const origin = request?.headers.get("Origin") ?? null;
  const allowOrigin = origin !== null && configuredOrigins(environment).has(origin) ? origin : null;
  return {
    "Access-Control-Allow-Headers": allowedHeaders,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Request-Id",
    "Cache-Control": "no-store",
    Vary: "Origin",
    ...(allowOrigin === null ? {} : { "Access-Control-Allow-Origin": allowOrigin }),
  };
}
