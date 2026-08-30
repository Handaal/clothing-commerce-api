// Request headers the management API accepts. Authorization carries the Clerk session token; X-Tenant-Id
// selects the tenant for tenant-scoped routes; X-Client-Type/Version are non-authoritative client
// metadata. The origin policy is intentionally unchanged; Admin Mobile is native and not browser-CORS
// constrained, but the contract stays ready for a future browser consumer. No credentialed wildcard is
// introduced: responses never set Access-Control-Allow-Credentials, so a wildcard origin stays safe.
const allowedHeaders =
  "Accept, Authorization, Content-Type, X-Tenant-Id, X-Client-Type, X-Client-Version";

export const corsHeaders = {
  "Access-Control-Allow-Headers": allowedHeaders,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Request-Id",
  "Cache-Control": "no-store",
} as const;
