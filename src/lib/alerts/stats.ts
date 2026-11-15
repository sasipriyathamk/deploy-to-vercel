import { milestoneStats } from "./milestones";
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows } from "@/lib/db/rows";

// Each alert keeps one fixed basis. Running peaks include its initial quoted baseline.
// Null observations are missing evidence; they never become zero returns.
const PATH = sql.raw(`WITH quotes AS (
  SELECT a.id AS alert_id,a.mint,a.entry_value,a.sent_at,o.id,o.observed_at,o.target_at,o.stage,
    floor(extract(epoch FROM o.observed_at-a.sent_at)/3600)::int AS hour_index,
    CASE WHEN a.basis='price' THEN o.price_usd ELSE o.mcap_usd END AS value
  FROM telegram_alerts a JOIN alert_observations o ON o.alert_id=a.id
  WHERE a.status='sent' AND o.observed_at>=a.sent_at
), peaks AS (
  SELECT *,greatest(entry_value,max(value) OVER(PARTITION BY alert_id ORDER BY observed_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS peak
  FROM quotes
), path AS (
  SELECT *,100*(value/entry_value-1) AS return_pct,100*(value/peak-1) AS drawdown_pct FROM peaks
)`);
export type PerformanceStats = {
  observations: number;
  priced_observations: number;
  minimum_sampled_return_pct: number | null;
  maximum_sampled_return_pct: number | null;
  maximum_sampled_drawdown_pct: number | null;
  latest_sampled_return_pct: number | null;
  last_priced_at: Date | string | null;
};
export async function performance(db: AppDb, alertId: number) {
  const result = await db.execute(sql`${PATH}
    SELECT count(*)::int AS observations,count(value)::int AS priced_observations,
      min(return_pct) AS minimum_sampled_return_pct,max(return_pct) AS maximum_sampled_return_pct,
      min(drawdown_pct) AS maximum_sampled_drawdown_pct,
      (array_agg(return_pct ORDER BY observed_at DESC,id DESC) FILTER(WHERE value IS NOT NULL))[1] AS latest_sampled_return_pct,
      max(observed_at) FILTER(WHERE value IS NOT NULL) AS last_priced_at
    FROM path WHERE alert_id=${alertId}`);
  return asRows<PerformanceStats>(result)[0];
}
export async function hourlyPerformance(db: AppDb, alertId: number) {
  return asRows<Record<string, unknown>>(
    await db.execute(sql`${PATH}
    SELECT hour_index,count(*)::int AS observations,count(value)::int AS priced_observations,
      min(observed_at) AS first_observed_at,max(observed_at) AS last_observed_at,
      (array_agg(return_pct ORDER BY observed_at DESC,id DESC) FILTER(WHERE value IS NOT NULL))[1] AS closing_sampled_return_pct,
      min(return_pct) AS minimum_sampled_return_pct,max(return_pct) AS maximum_sampled_return_pct,
      min(drawdown_pct) AS maximum_sampled_drawdown_pct,
      max(extract(epoch FROM observed_at-target_at)) FILTER(WHERE stage='hourly') AS hourly_capture_lateness_seconds
    FROM path WHERE alert_id=${alertId} GROUP BY hour_index ORDER BY hour_index`),
  );
}
export async function alertSystemStats(db: AppDb) {
  const states = asRows(
    await db.execute(
      sql`SELECT status,count(*)::int AS count FROM telegram_alerts GROUP BY status ORDER BY status`,
    ),
  );
  const outcomes = asRows(
    await db.execute(sql`${PATH}, per_alert AS (
    SELECT alert_id,count(value) AS n,
      (array_agg(return_pct ORDER BY observed_at DESC,id DESC) FILTER(WHERE value IS NOT NULL))[1] AS latest_return,
      min(drawdown_pct) AS maximum_drawdown FROM path GROUP BY alert_id
  ) SELECT count(*) FILTER(WHERE n>0)::int AS alerts_with_priced_followup,
    count(*) FILTER(WHERE latest_return>0)::int AS alerts_currently_above_baseline,
    count(*) FILTER(WHERE n IS NULL OR n=0)::int AS alerts_without_priced_followup,
    avg(latest_return) AS mean_latest_sampled_return_pct,min(maximum_drawdown) AS worst_sampled_drawdown_pct
    FROM telegram_alerts a LEFT JOIN per_alert p ON p.alert_id=a.id WHERE a.status='sent' `),
  )[0];
  const monitoring = asRows(
    await db.execute(sql`SELECT
    count(*) FILTER(WHERE status='sent' AND next_snapshot_at<=now())::int AS hourly_due,
    count(*) FILTER(WHERE status='pending' AND snapshot_at<now()-interval '5 minutes')::int AS queued_stale,
    count(*) FILTER(WHERE status='pending' AND snapshot_at>=now()-interval '5 minutes')::int AS queued_fresh,
    count(*) FILTER(WHERE status='sending' AND attempted_at<now()-interval '2 minutes')::int AS stalled_delivery_needs_reconciliation
    FROM telegram_alerts WHERE status IN ('sent','sending','pending')`),
  )[0];
  return {
    threshold: 75,
    milestones: await milestoneStats(db),
    delivery: states,
    outcomes,
    monitoring,
    methodology:
      "Quoted alert baseline; observations after confirmed send time; fixed price or market-cap basis. Sampled returns exclude fees and slippage. Drawdown is peak-to-trough from the running observed peak, including the baseline. Gaps remain unknown; no price path is interpolated.",
  };
}

/** Bounded, safe token-reference projection for the UI; full records remain protected. */
export async function recentAlertPerformance(db: AppDb) {
  return asRows<Record<string, unknown>>(
    await db.execute(sql`${PATH}, results AS (
    SELECT alert_id,count(value)::int AS priced_observations,
      (array_agg(return_pct ORDER BY observed_at DESC,id DESC) FILTER(WHERE value IS NOT NULL))[1] AS latest_return,
      min(drawdown_pct) AS maximum_drawdown FROM path GROUP BY alert_id
  ) SELECT a.id,a.mint,coalesce(t.symbol,t.name,a.mint) AS symbol,a.confidence,a.sent_at,a.basis,
    r.priced_observations,r.latest_return,r.maximum_drawdown,
    (SELECT array_agg(m.multiple ORDER BY m.multiple) FROM telegram_alert_milestones m WHERE m.alert_id=a.id) AS milestones
    FROM telegram_alerts a LEFT JOIN tokens t ON t.mint=a.mint LEFT JOIN results r ON r.alert_id=a.id
    WHERE a.status='sent' ORDER BY a.sent_at DESC,a.id DESC LIMIT 20`),
  );
}
