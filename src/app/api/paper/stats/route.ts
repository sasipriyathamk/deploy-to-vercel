import { withDb } from "@/lib/http";
import { signalUniverseSummary, recentAlertPerformanceFull, drawdownRecoveryChart } from "@/lib/paper/stats";
import { syncAlertSignals } from "@/lib/paper/store";
import { drawdownEpisodeSummary } from "@/lib/paper/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(async (db) => {
    const [universe, recentPerf, ddSummary, ddChart] = await Promise.all([
      signalUniverseSummary(db),
      recentAlertPerformanceFull(db),
      drawdownEpisodeSummary(db),
      drawdownRecoveryChart(db),
    ]);
    return {
      universe: universe[0] ?? null,
      recentPerformance: recentPerf,
      drawdownSummary: ddSummary[0] ?? null,
      drawdownChart: ddChart,
      methodology:
        "All statistics are sampled estimates using the alert observation price path. " +
        "Results are labelled as simulated and do not represent executable returns. " +
        "Missing observations are preserved as gaps; no interpolation is applied.",
    };
  });
}

/** POST /api/paper/stats — sync alert signals + run portfolio engine */
export async function POST() {
  return withDb(async (db) => {
    const synced = await syncAlertSignals(db);
    const { runPortfolioEngine, ensureDefaultPortfolio } = await import("@/lib/paper/engine");
    await ensureDefaultPortfolio(db);
    const result = await runPortfolioEngine(db);
    return { synced, ...result };
  });
}
