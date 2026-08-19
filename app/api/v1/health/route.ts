import { NextResponse } from "next/server";

import { getHealth } from "../../../../src/health/get-health";
import { corsHeaders } from "../../../../src/http/cors";

export function GET() {
  return NextResponse.json(getHealth(), { headers: corsHeaders });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
