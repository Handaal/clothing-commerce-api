import { NextResponse } from "next/server";

import { getHealth } from "../../../../src/health/get-health";
import { corsHeaders } from "../../../../src/http/cors";

export function GET(request: Request) {
  return NextResponse.json(getHealth(), { headers: corsHeaders(request) });
}

export function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
