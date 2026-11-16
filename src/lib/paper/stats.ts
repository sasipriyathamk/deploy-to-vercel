/**
 * paper/stats.ts
 *
 * Aggregate statistics for the paper-trading dashboard.
 * Reads from paper_* tables and alert_observations.
 */
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows } from "@/lib/db/rows";

/** Summary of the alert signal universe */
export async function signalUniverseSummary(db: AppDb) {
  return asRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        count(*)::int AS total_sent_alerts,
        count(*) FILTER(WHERE a.confidence >= 90)::int AS band_90plus,
        count(*) FILTER(WHERE a.confidence BETWEEN 85 AND 89)::int AS band_85_89,
        count(*) FILTER(WHERE a.confidence BETWEEN 80 AND 84)::int AS band_80_84,
        count(*) FILTER(WHERE a.confidence BETWEEN 75 AND 79)::int AS band_75_79,
        count(*) FILTER(WHERE o.id IS NOT NULL)::int AS with_observations,
        min(a.sent_at) AS earliest_signal,
        max(a.sent_at) AS latest_signal
      FROM telegram_alerts a
      LEFT JOIN alert_observations o ON o.alert_id = a.id
      WHERE a.status = 'sent'
    `),
  );
}

/** Per-alert performance summary for the recent-alerts list */
export async function recentAlertPerformanceFull(db: AppDb) {
  return asRows<Record<string, unknown>>(
    await db.execute(sql`
      WITH obs AS (
        SELECT
          o.alert_id,
          CASE WHEN a.basis='price' THEN o.price_usd ELSE o.mcap_usd END AS value,
          o.observed_at
        FROM alert_observations o
        JOIN telegram_alerts a ON a.id = o.alert_id
        WHERE a.status = 'sent'
      ),
      peaks AS (
        SELECT *,
          greatest(
            (SELECT entry_value FROM telegram_alerts WHERE id=alert_id),
            max(value) OVER(PARTITION BY alert_id ORDER BY observed_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          ) AS peak
        FROM obs
      ),
      per_alert AS (
        SELECT
          alert_id,
          count(value)::int AS n_obs,
          max(100*(value/(SELECT entry_value FROM telegram_alerts WHERE id=alert_id)-1)) AS mfe_pct,
          min(100*(value/(SELECT entry_value FROM telegram_alerts WHERE id=alert_id)-1)) AS mae_pct,
          (array_agg(100*(value/(SELECT entry_value FROM telegram_alerts WHERE id=alert_id)-1)
            ORDER BY observed_at DESC NULLS LAST) FILTER(WHERE value IS NOT NULL))[1] AS latest_return_pct,
          min(100*(value/peak-1)) AS max_drawdown_pct
        FROM peaks
        GROUP BY alert_id
      )
      SELECT
        a.id, a.mint, coalesce(t.symbol,t.name,a.mint) AS symbol,
        a.confidence, a.sent_at, a.basis, a.entry_value,
        p.n_obs, p.mfe_pct, p.mae_pct, p.latest_return_pct, p.max_drawdown_pct,
        (SELECT array_agg(m.multiple ORDER BY m.multiple)
          FROM telegram_alert_milestones m WHERE m.alert_id=a.id) AS milestones
      FROM telegram_alerts a
      LEFT JOIN tokens t ON t.mint=a.mint
      LEFT JOIN per_alert p ON p.alert_id=a.id
      WHERE a.status='sent'
      ORDER BY a.sent_at DESC, a.id DESC
      LIMIT 50
    `),
  );
}

/** Portfolio summary for a single portfolio */
export async function portfolioSummary(db: AppDb, portfolioId: number) {
  const portfolio = asRows<Record<string, unknown>>(
    await db.execute(
      sql`SELECT * FROM paper_portfolios WHERE id=${portfolioId}`,
    ),
  )[0];
  if (!portfolio) return null;

  const positions = asRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        count(*) FILTER(WHERE status='open')::int AS open_positions,
        count(*) FILTER(WHERE status='closed')::int AS closed_positions,
        count(*) FILTER(WHERE status='closed' AND realised_pnl_usd > 0)::int AS winners,
        count(*) FILTER(WHERE status='closed' AND realised_pnl_usd <= 0)::int AS losers,
        sum(realised_pnl_usd) FILTER(WHERE status='closed') AS total_realised_pnl,
        avg(realised_pnl_pct) FILTER(WHERE status='closed') AS avg_realised_pct,
        max(mfe_pct) AS best_mfe,
        min(mae_pct) AS worst_mae
      FROM paper_positions
      WHERE portfolio_id = ${portfolioId}
    `),
  )[0];

  const equity = asRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT equity, drawdown_pct, snapshot_date
      FROM paper_equity_snapshots
      WHERE portfolio_id = ${portfolioId}
      ORDER BY snapshot_date DESC LIMIT 1
    `),
  )[0];

  const drawdown = asRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT min(drawdown_pct) AS max_drawdown
      FROM paper_equity_snapshots
      WHERE portfolio_id = ${portfolioId}
    `),
  )[0];

  return { portfolio, positions, equity, drawdown };
}

/** Drawdown depth vs recovery probability — for the scatter/heatmap chart */
export async function drawdownRecoveryChart(db: AppDb) {
  return asRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        round(depth_pct / 10) * 10 AS depth_bucket,
        count(*)::int AS episodes,
        100.0 * count(*) FILTER(WHERE local_high_recovered_at IS NOT NULL)::float / count(*) AS recovery_rate_pct,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM local_high_recovered_at - trough_observed_at)/60
        ) FILTER(WHERE local_high_recovered_at IS NOT NULL) AS median_recovery_minutes
      FROM paper_drawdown_episodes
      WHERE depth_pct IS NOT NULL
      GROUP BY depth_bucket
      ORDER BY depth_bucket
    `),
  );
}
