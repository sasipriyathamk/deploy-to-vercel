import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/db/index";
import { pipelineStats, watchingFreshness } from "@/lib/db/repo";
import { presentStats } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const handle = await getDatabase();
    const [rawStats, freshness] = await Promise.all([pipelineStats(handle.db), watchingFreshness(handle.db)]);
    const stats = presentStats(rawStats);
    return NextResponse.json({
      ok: true,
      database: handle.mode,
      watchingFreshness: freshness,
      queue: stats.queue,
      depthByType: stats.depthByType,
      runs: stats.runs,
      dataQuality: stats.dataQuality,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unavailable";
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
