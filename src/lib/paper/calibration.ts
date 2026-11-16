/**
 * paper/calibration.ts
 *
 * Confidence calibration module (Priority 1).
 *
 * Reads from alert_observations (the existing price-path table) and
 * aggregates per confidence band and forward window. Results are cached in
 * paper_calibration. Censored outcomes (window not yet complete) are
 * flagged but NOT excluded — they contribute to sample counts.
 *
 * IMPORTANT: Never uses a confidence value that became available after
 * the signal_at timestamp (no look-ahead bias).
 */
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows, asNumber } from "@/lib/db/rows";

export type ConfidenceBand = {
  lo: number;
  hi: number;
  label: string;
};

export const CONFIDENCE_BANDS: ConfidenceBand[] = [
  { lo: 75, hi: 79, label: "75–79" },
  { lo: 80, hi: 84, label: "80–84" },
  { lo: 85, hi: 89, label: "85–89" },
  { lo: 90, hi: 100, label: "90+" },
];

/** Forward windows in minutes */
export const FORWARD_WINDOWS = [15, 60, 360, 1440, 4320];

export type CalibrationRow = {
  confidence_lo: number;
  confidence_hi: number;
  window_minutes: number;
  signal_type: string;
  computed_at: Date | string;
  n_signals: number;
  n_with_data: number;
  n_censored: number;
  pct_plus25: number | null;
  pct_plus50: number | null;
  pct_plus100: number | null;
  pct_plus200: number | null;
  pct_plus500: number | null;
  pct_minus10: number | null;
  pct_minus20: number | null;
  pct_minus30: number | null;
  pct_minus50: number | null;
  median_mae: number | null;
  median_mfe: number | null;
  recovery_probability: number | null;
  median_recovery_minutes: number | null;
  prob_2x_before_30: number | null;
  prob_30_before_2x: number | null;
  median_minutes_to_peak: number | null;
  failure_rate: number | null;
};

/**
 * Compute calibration statistics from alert_observations for a single
 * confidence band + forward window combination.
 *
 * Uses the existing alert_observations table which is authoritative for
 * the alert signal universe.
 */
export async function computeCalibrationBand(
  db: AppDb,
  band: ConfidenceBand,
  windowMinutes: number,
  signalType = "alert",
): Promise<Omit<CalibrationRow, "computed_at"> | null> {
  // We read from telegram_alerts (the signal universe) and join to
  // alert_observations (the price path). Only use observations that
  // fall within the forward window from sent_at (the signal time).
  // The confidence used is the alert's confidence at the time of sending —
  // never a later updated value.
  const result = await db.execute(sql`
    WITH signals AS (
      SELECT
        a.id AS alert_id,
        a.mint,
        a.confidence,
        a.sent_at AS signal_at,
        a.entry_value,
        a.basis,
        a.sent_at + (${windowMinutes} * interval '1 minute') AS window_end,
        -- Window is complete if enough time has passed since the signal
        (now() > a.sent_at + (${windowMinutes} * interval '1 minute')) AS window_complete
      FROM telegram_alerts a
      WHERE a.status = 'sent'
        AND a.confidence >= ${band.lo}
        AND a.confidence <= ${band.hi}
    ),
    obs AS (
      SELECT
        s.alert_id,
        s.signal_at,
        s.entry_value,
        s.basis,
        s.window_end,
        s.window_complete,
        o.observed_at,
        CASE WHEN s.basis='price' THEN o.price_usd ELSE o.mcap_usd END AS value,
        extract(epoch FROM o.observed_at - s.signal_at)/60 AS minutes_elapsed
      FROM signals s
      JOIN alert_observations o ON o.alert_id = s.alert_id
      WHERE o.observed_at >= s.signal_at
        AND o.observed_at <= s.window_end
    ),
    per_signal AS (
      SELECT
        alert_id,
        window_complete,
        entry_value,
        count(value) AS n_obs,
        -- Maximum return in window (MFE)
        max(100 * (value / entry_value - 1)) FILTER(WHERE value IS NOT NULL) AS mfe_pct,
        -- Minimum return in window (MAE)
        min(100 * (value / entry_value - 1)) FILTER(WHERE value IS NOT NULL) AS mae_pct,
        -- Time to peak
        (extract(epoch FROM
          (array_agg(observed_at ORDER BY value DESC NULLS LAST) FILTER(WHERE value IS NOT NULL))[1]
          - (array_agg(observed_at ORDER BY observed_at) FILTER(WHERE value IS NOT NULL))[1]
        ) / 60) AS minutes_to_peak,
        -- Recovery: did price return to entry_value after falling below it?
        bool_or(value >= entry_value AND minutes_elapsed > 0) AS recovered,
        -- Time to recovery (first observation at or above entry_value)
        min(minutes_elapsed) FILTER(WHERE value >= entry_value AND minutes_elapsed > 0) AS recovery_minutes,
        -- 2x vs -30% race
        min(minutes_elapsed) FILTER(WHERE value >= entry_value * 2) AS minutes_to_2x,
        min(minutes_elapsed) FILTER(WHERE value <= entry_value * 0.70) AS minutes_to_30pct_down
      FROM obs
      GROUP BY alert_id, window_complete, entry_value
    ),
    agg AS (
      SELECT
        count(*)::int AS n_signals,
        count(*) FILTER(WHERE n_obs > 0)::int AS n_with_data,
        count(*) FILTER(WHERE NOT window_complete)::int AS n_censored,
        -- Hit rates (using MFE as the best price in the window)
        100.0 * count(*) FILTER(WHERE mfe_pct >= 25)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_plus25,
        100.0 * count(*) FILTER(WHERE mfe_pct >= 50)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_plus50,
        100.0 * count(*) FILTER(WHERE mfe_pct >= 100)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_plus100,
        100.0 * count(*) FILTER(WHERE mfe_pct >= 200)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_plus200,
        100.0 * count(*) FILTER(WHERE mfe_pct >= 500)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_plus500,
        -- Fall rates (using MAE as the worst price in the window)
        100.0 * count(*) FILTER(WHERE mae_pct <= -10)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_minus10,
        100.0 * count(*) FILTER(WHERE mae_pct <= -20)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_minus20,
        100.0 * count(*) FILTER(WHERE mae_pct <= -30)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_minus30,
        100.0 * count(*) FILTER(WHERE mae_pct <= -50)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS pct_minus50,
        -- Median MAE / MFE
        percentile_cont(0.5) WITHIN GROUP (ORDER BY mae_pct) AS median_mae,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY mfe_pct) AS median_mfe,
        -- Recovery stats
        100.0 * count(*) FILTER(WHERE recovered)::float / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS recovery_probability,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY recovery_minutes) FILTER(WHERE recovered) AS median_recovery_minutes,
        -- 2x before -30%
        100.0 * count(*) FILTER(WHERE minutes_to_2x IS NOT NULL AND (minutes_to_30pct_down IS NULL OR minutes_to_2x < minutes_to_30pct_down))::float
          / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS prob_2x_before_30,
        100.0 * count(*) FILTER(WHERE minutes_to_30pct_down IS NOT NULL AND (minutes_to_2x IS NULL OR minutes_to_30pct_down <= minutes_to_2x))::float
          / NULLIF(count(*) FILTER(WHERE n_obs > 0), 0) AS prob_30_before_2x,
        -- Time to peak
        percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes_to_peak) AS median_minutes_to_peak,
        -- Failure rate: fell >50% and never recovered (only for complete windows)
        100.0 * count(*) FILTER(WHERE window_complete AND mae_pct <= -50 AND NOT COALESCE(recovered, false))::float
          / NULLIF(count(*) FILTER(WHERE window_complete AND n_obs > 0), 0) AS failure_rate
      FROM per_signal
    )
    SELECT * FROM agg
  `);

  const row = asRows<Record<string, unknown>>(result)[0];
  if (!row) return null;

  return {
    confidence_lo: band.lo,
    confidence_hi: band.hi,
    window_minutes: windowMinutes,
    signal_type: signalType,
    n_signals: asNumber(row.n_signals) ?? 0,
    n_with_data: asNumber(row.n_with_data) ?? 0,
    n_censored: asNumber(row.n_censored) ?? 0,
    pct_plus25: asNumber(row.pct_plus25),
    pct_plus50: asNumber(row.pct_plus50),
    pct_plus100: asNumber(row.pct_plus100),
    pct_plus200: asNumber(row.pct_plus200),
    pct_plus500: asNumber(row.pct_plus500),
    pct_minus10: asNumber(row.pct_minus10),
    pct_minus20: asNumber(row.pct_minus20),
    pct_minus30: asNumber(row.pct_minus30),
    pct_minus50: asNumber(row.pct_minus50),
    median_mae: asNumber(row.median_mae),
    median_mfe: asNumber(row.median_mfe),
    recovery_probability: asNumber(row.recovery_probability),
    median_recovery_minutes: asNumber(row.median_recovery_minutes),
    prob_2x_before_30: asNumber(row.prob_2x_before_30),
    prob_30_before_2x: asNumber(row.prob_30_before_2x),
    median_minutes_to_peak: asNumber(row.median_minutes_to_peak),
    failure_rate: asNumber(row.failure_rate),
  };
}

/**
 * Recompute and cache all calibration bands × windows.
 * Safe to call repeatedly — uses UPSERT.
 */
export async function refreshCalibration(
  db: AppDb,
  signalType = "alert",
): Promise<{ computed: number }> {
  let computed = 0;
  for (const band of CONFIDENCE_BANDS) {
    for (const window of FORWARD_WINDOWS) {
      const stats = await computeCalibrationBand(db, band, window, signalType);
      if (!stats) continue;
      await db.execute(sql`
        INSERT INTO paper_calibration(
          confidence_lo, confidence_hi, window_minutes, signal_type,
          n_signals, n_with_data, n_censored,
          pct_plus25, pct_plus50, pct_plus100, pct_plus200, pct_plus500,
          pct_minus10, pct_minus20, pct_minus30, pct_minus50,
          median_mae, median_mfe,
          recovery_probability, median_recovery_minutes,
          prob_2x_before_30, prob_30_before_2x,
          median_minutes_to_peak, failure_rate
        ) VALUES (
          ${stats.confidence_lo}, ${stats.confidence_hi}, ${stats.window_minutes}, ${stats.signal_type},
          ${stats.n_signals}, ${stats.n_with_data}, ${stats.n_censored},
          ${stats.pct_plus25}, ${stats.pct_plus50}, ${stats.pct_plus100}, ${stats.pct_plus200}, ${stats.pct_plus500},
          ${stats.pct_minus10}, ${stats.pct_minus20}, ${stats.pct_minus30}, ${stats.pct_minus50},
          ${stats.median_mae}, ${stats.median_mfe},
          ${stats.recovery_probability}, ${stats.median_recovery_minutes},
          ${stats.prob_2x_before_30}, ${stats.prob_30_before_2x},
          ${stats.median_minutes_to_peak}, ${stats.failure_rate}
        )
        ON CONFLICT(confidence_lo, confidence_hi, window_minutes, signal_type) DO UPDATE SET
          computed_at = now(),
          n_signals = EXCLUDED.n_signals,
          n_with_data = EXCLUDED.n_with_data,
          n_censored = EXCLUDED.n_censored,
          pct_plus25 = EXCLUDED.pct_plus25,
          pct_plus50 = EXCLUDED.pct_plus50,
          pct_plus100 = EXCLUDED.pct_plus100,
          pct_plus200 = EXCLUDED.pct_plus200,
          pct_plus500 = EXCLUDED.pct_plus500,
          pct_minus10 = EXCLUDED.pct_minus10,
          pct_minus20 = EXCLUDED.pct_minus20,
          pct_minus30 = EXCLUDED.pct_minus30,
          pct_minus50 = EXCLUDED.pct_minus50,
          median_mae = EXCLUDED.median_mae,
          median_mfe = EXCLUDED.median_mfe,
          recovery_probability = EXCLUDED.recovery_probability,
          median_recovery_minutes = EXCLUDED.median_recovery_minutes,
          prob_2x_before_30 = EXCLUDED.prob_2x_before_30,
          prob_30_before_2x = EXCLUDED.prob_30_before_2x,
          median_minutes_to_peak = EXCLUDED.median_minutes_to_peak,
          failure_rate = EXCLUDED.failure_rate
      `);
      computed++;
    }
  }
  return { computed };
}

/** Read cached calibration rows for the UI */
export async function getCalibration(
  db: AppDb,
  signalType = "alert",
): Promise<CalibrationRow[]> {
  return asRows<CalibrationRow>(
    await db.execute(sql`
      SELECT * FROM paper_calibration
      WHERE signal_type = ${signalType}
      ORDER BY confidence_lo, window_minutes
    `),
  );
}
