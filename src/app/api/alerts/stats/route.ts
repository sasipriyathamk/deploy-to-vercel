import { NextResponse } from "next/server";
import { cronAuthorized, unauthorized, withDb } from "@/lib/http";
import { alertsEnabled } from "@/lib/alerts/store";
import { alertSystemStats } from "@/lib/alerts/stats";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return unauthorized();
  if (!alertsEnabled()) return NextResponse.json({ enabled: false });
  return withDb((db) => alertSystemStats(db));
}
