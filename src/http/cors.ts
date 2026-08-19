const allowedHeaders = "Accept, Content-Type, X-Client-Type, X-Client-Version";

export const corsHeaders = {
  "Access-Control-Allow-Headers": allowedHeaders,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
} as const;
