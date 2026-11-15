import { listMilestones } from "@/lib/alerts/milestones";
import { NextResponse } from "next/server";
import { cronAuthorized, unauthorized, withDb, HttpError } from "@/lib/http";
import {
  alertsEnabled,
  alertById,
  alertObservations,
} from "@/lib/alerts/store";
import { performance, hourlyPerformance } from "@/lib/alerts/stats";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!cronAuthorized(request)) return unauthorized();
  if (!alertsEnabled()) return NextResponse.json({ enabled: false });
  const id = Number((await context.params).id),
    after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(after) ||
    after < 0
  )
    return NextResponse.json(
      { error: "Invalid ID or cursor" },
      { status: 400 },
    );
  return withDb(async (db) => {
    const alert = await alertById(db, id);
    if (!alert) throw new HttpError(404, "Sent alert not found");
    const [observations, stats, hourly, milestones] = await Promise.all([
      alertObservations(db, id, after, 200),
      performance(db, id),
      hourlyPerformance(db, id),
      listMilestones(db, id),
    ]);
    return {
      alert,
      observations,
      performance: stats,
      hourly,
      milestones,
      nextAfter: observations.length === 200 ? observations[199].id : null,
    };
  });
}
