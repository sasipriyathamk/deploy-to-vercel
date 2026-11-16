import { withDb } from "@/lib/http";
import { drawdownRecoveryChart } from "@/lib/paper/stats";
import { drawdownEpisodeSummary } from "@/lib/paper/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(async (db) => {
    const [summary, chart] = await Promise.all([
      drawdownEpisodeSummary(db),
      drawdownRecoveryChart(db),
    ]);
    return {
      summary: summary[0] ?? null,
      depthVsRecoveryChart: chart,
      methodology:
        "Episodes are detected when the running peak falls more than 5% from its high. " +
        "Recovery milestones are distinct: entry-price recovery, local-high recovery, ATH recovery, new ATH. " +
        "Gaps in observations mean the exact trough may be missed.",
    };
  });
}
