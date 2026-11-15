import { fomoEnvPresent } from "@/lib/ai/fomo";
import type { ShadowStats } from "@/lib/ai/types";
import { gainSinceFirstAlert, gatewayConfigured, istDayStart, loadVerdictConfig, summarizeShadowBuckets } from "@/lib/ai/verdict-logic";
import { countCappedVerdictsSince, shadowGainRows } from "@/lib/db/verdicts";
import { withDb } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(async (db) => {
    const config = loadVerdictConfig();
    const now = new Date();
    const dayStart = istDayStart(now);
    const [usedToday, rows] = await Promise.all([
      countCappedVerdictsSince(db, dayStart),
      shadowGainRows(db),
    ]);
    const buckets = summarizeShadowBuckets(
      rows.map((row) => ({
        verdict: row.verdict,
        ...gainSinceFirstAlert({
          lastPriceUsd: row.lastPriceUsd,
          firstAlertPriceUsd: row.firstAlertPriceUsd,
          lastMcapUsd: row.lastMcapUsd,
          firstAlertMcapUsd: row.firstAlertMcapUsd,
          athPriceUsd: row.athPriceUsd,
          athGainPct: row.athGainPct,
        }),
      })),
    );
    const body: ShadowStats = {
      shadow: true,
      configured: gatewayConfigured(config),
      fomoConfigured: fomoEnvPresent(),
      dailyCap: config.dailyCap,
      usedToday,
      dayStart: dayStart.toISOString(),
      buckets,
    };
    return body;
  });
}
