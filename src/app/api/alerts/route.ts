import { NextResponse } from "next/server";
import { cronAuthorized, unauthorized, withDb } from "@/lib/http";
import { alertsEnabled, listAlerts } from "@/lib/alerts/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return unauthorized();
  if (!alertsEnabled())
    return NextResponse.json({ enabled: false, alerts: [] });
  const value = new URL(request.url).searchParams.get("before");
  const before = value == null ? null : Number(value);
  if (before != null && (!Number.isSafeInteger(before) || before <= 0))
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  return withDb(async (db) => {
    const alerts = await listAlerts(db, before);
    return {
      enabled: true,
      alerts,
      nextBefore: alerts.length === 50 ? alerts[49].id : null,
    };
  });
}
