/**
 * paper/sampler.ts
 *
 * Adaptive sampler: decides whether a token needs an additional price
 * observation and schedules it via the existing pipeline queue.
 *
 * Policy:
 * - Newly alerted tokens: sample densely (every 5m) for first 2 hours.
 * - Open paper positions: sample every 10m for 72h.
 * - Active drawdown episodes: sample every 15m.
 * - Tokens approaching strategy thresholds: sample every 20m.
 * - Inactive / expired: no additional sampling.
 *
 * NEVER creates a competing cron loop. The sampler is called FROM the
 * existing pipeline cron, within its existing budget gates.
 *
 * NEVER samples more than MAX_SAMPLER_JOBS_PER_RUN tokens per cron tick.
 */
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows } from "@/lib/db/rows";

/** Hard cap: never queue more than this many paper-sampling jobs per cron run. */
const MAX_SAMPLER_JOBS_PER_RUN = 10;

export type SamplerConfig = {
  /** Dense sample interval for new alerts (minutes) */
  newAlertIntervalMin: number;
  /** Dense period duration (hours) */
  newAlertDensePeriodHours: number;
  /** Open position sample interval (minutes) */
  positionIntervalMin: number;
  /** Max position hold duration (hours) */
  positionMaxHoldHours: number;
  /** Drawdown episode sample interval (minutes) */
  drawdownIntervalMin: number;
  /** Threshold-proximity interval (minutes) */
  thresholdProximityIntervalMin: number;
};

export const DEFAULT_SAMPLER_CONFIG: SamplerConfig = {
  newAlertIntervalMin: 5,
  newAlertDensePeriodHours: 2,
  positionIntervalMin: 10,
  positionMaxHoldHours: 72,
  drawdownIntervalMin: 15,
  thresholdProximityIntervalMin: 20,
};

/** Returns the list of mints that need an additional paper sample. */
export async function selectSampleTargets(
  db: AppDb,
  config: SamplerConfig = DEFAULT_SAMPLER_CONFIG,
): Promise<string[]> {
  const targets = new Set<string>();

  // 1. Recently alerted tokens (dense early sampling)
  const newAlerts = asRows<{ mint: string }>(
    await db.execute(sql`
      SELECT a.mint FROM telegram_alerts a
      WHERE a.status = 'sent'
        AND a.sent_at >= now() - ${config.newAlertDensePeriodHours} * interval '1 hour'
        AND (
          SELECT max(o.observed_at) FROM alert_observations o WHERE o.alert_id=a.id
        ) < now() - ${config.newAlertIntervalMin} * interval '1 minute'
      ORDER BY a.sent_at DESC
      LIMIT ${Math.floor(MAX_SAMPLER_JOBS_PER_RUN / 2)}
    `),
  );
  newAlerts.forEach((r) => targets.add(r.mint));

  if (targets.size >= MAX_SAMPLER_JOBS_PER_RUN) return [...targets];

  // 2. Open paper positions
  const openPos = asRows<{ mint: string }>(
    await db.execute(sql`
      SELECT DISTINCT p.mint FROM paper_positions p
      WHERE p.status = 'open'
        AND p.entry_at >= now() - ${config.positionMaxHoldHours} * interval '1 hour'
        AND (
          SELECT max(o.observed_at)
          FROM alert_observations o
          JOIN paper_signals ps ON ps.alert_id = o.alert_id
          WHERE ps.id = p.signal_id
        ) < now() - ${config.positionIntervalMin} * interval '1 minute'
      LIMIT ${MAX_SAMPLER_JOBS_PER_RUN - targets.size}
    `),
  );
  openPos.forEach((r) => targets.add(r.mint));

  if (targets.size >= MAX_SAMPLER_JOBS_PER_RUN) return [...targets];

  // 3. Active drawdown episodes
  const drawdowns = asRows<{ mint: string }>(
    await db.execute(sql`
      SELECT DISTINCT a.mint
      FROM paper_drawdown_episodes d
      JOIN telegram_alerts a ON a.id = d.alert_id
      WHERE d.resolved_at IS NULL
        AND d.trough_observed_at IS NOT NULL
        AND d.local_high_recovered_at IS NULL
        AND (
          SELECT max(o.observed_at) FROM alert_observations o WHERE o.alert_id=a.id
        ) < now() - ${config.drawdownIntervalMin} * interval '1 minute'
      LIMIT ${MAX_SAMPLER_JOBS_PER_RUN - targets.size}
    `),
  );
  drawdowns.forEach((r) => targets.add(r.mint));

  return [...targets].slice(0, MAX_SAMPLER_JOBS_PER_RUN);
}

/**
 * Queue paper-sample recheck jobs for selected targets.
 * Uses the existing pipeline_jobs table with type 'paper_sample'.
 * Returns the number of jobs enqueued.
 */
export async function enqueuePaperSamples(
  db: AppDb,
  config: SamplerConfig = DEFAULT_SAMPLER_CONFIG,
): Promise<number> {
  const targets = await selectSampleTargets(db, config);
  if (targets.length === 0) return 0;

  let enqueued = 0;
  for (const mint of targets) {
    await db.execute(sql`
      INSERT INTO pipeline_jobs(type, payload, run_after)
      VALUES ('paper_sample', ${JSON.stringify({ mint })}::jsonb, now())
      ON CONFLICT DO NOTHING
    `);
    enqueued++;
  }
  return enqueued;
}
