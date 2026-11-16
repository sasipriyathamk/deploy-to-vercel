/**
 * paper/store.ts
 *
 * Low-level DB operations for the paper-trading system.
 * All queries read from alert_observations (owned by the alerts system)
 * and write only to paper_* tables.
 */
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows, asNumber, asDate } from "@/lib/db/rows";

export type PaperSignal = {
  id: number;
  mint: string;
  signal_type: "alert" | "research" | "watching" | "candidate";
  confidence: number;
  qualified_at: Date | string;
  snapshot_at: Date | string;
  basis: "price" | "mcap";
  entry_value: number;
  price_usd: number | null;
  mcap_usd: number | null;
  liq_usd: number | null;
  vol_m5: number | null;
  alert_id: number | null;
  strategy_id: string | null;
  strategy_version: number;
};

export type PaperPortfolio = {
  id: number;
  name: string;
  strategy_id: string;
  strategy_version: number;
  starting_capital: number;
  position_sizing: "fixed_dollar" | "percentage";
  position_size: number;
  max_positions: number;
  max_exposure_per_token: number;
  max_total_exposure: number;
};

export type PaperPosition = {
  id: number;
  portfolio_id: number;
  signal_id: number;
  mint: string;
  entry_at: Date | string;
  entry_quote_price: number;
  entry_fill_price: number;
  entry_slippage_pct: number;
  entry_fee_pct: number;
  size_usd: number;
  exit_at: Date | string | null;
  exit_quote_price: number | null;
  exit_fill_price: number | null;
  exit_reason: string | null;
  realised_pnl_usd: number | null;
  realised_pnl_pct: number | null;
  peak_price: number | null;
  peak_at: Date | string | null;
  mae_pct: number | null;
  mfe_pct: number | null;
  status: "open" | "closed";
};

// ----------------------------------------------------------------
// Signal upsert — called when a qualifying confidence event occurs
// ----------------------------------------------------------------
export async function upsertPaperSignal(
  db: AppDb,
  opts: {
    mint: string;
    signalType: PaperSignal["signal_type"];
    confidence: number;
    qualifiedAt: Date;
    snapshotAt: Date;
    basis: "price" | "mcap";
    entryValue: number;
    priceUsd?: number | null;
    mcapUsd?: number | null;
    liqUsd?: number | null;
    volM5?: number | null;
    alertId?: number | null;
    strategyId?: string | null;
    strategyVersion?: number;
  },
): Promise<number | null> {
  const result = await db.execute(sql`
    INSERT INTO paper_signals(
      mint, signal_type, confidence, qualified_at, snapshot_at,
      basis, entry_value, price_usd, mcap_usd, liq_usd, vol_m5,
      alert_id, strategy_id, strategy_version
    ) VALUES (
      ${opts.mint}, ${opts.signalType}, ${opts.confidence},
      ${opts.qualifiedAt}, ${opts.snapshotAt},
      ${opts.basis}, ${opts.entryValue},
      ${opts.priceUsd ?? null}, ${opts.mcapUsd ?? null},
      ${opts.liqUsd ?? null}, ${opts.volM5 ?? null},
      ${opts.alertId ?? null}, ${opts.strategyId ?? null},
      ${opts.strategyVersion ?? 1}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const rows = asRows<{ id: number }>(result);
  return rows[0] ? Number(rows[0].id) : null;
}

// ----------------------------------------------------------------
// Sync research signals from sent telegram_alerts (back-fill)
// ----------------------------------------------------------------
export async function syncAlertSignals(db: AppDb): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO paper_signals(
      mint, signal_type, confidence, qualified_at, snapshot_at,
      basis, entry_value, price_usd, mcap_usd, alert_id
    )
    SELECT
      a.mint, 'alert', a.confidence, a.qualified_at, a.snapshot_at,
      a.basis, a.entry_value,
      CASE WHEN a.basis='price' THEN a.entry_value ELSE NULL END,
      CASE WHEN a.basis='mcap'  THEN a.entry_value ELSE NULL END,
      a.id
    FROM telegram_alerts a
    WHERE a.status = 'sent'
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return asRows(result).length;
}

// ----------------------------------------------------------------
// Portfolio CRUD
// ----------------------------------------------------------------
export async function createPortfolio(
  db: AppDb,
  opts: Omit<PaperPortfolio, "id">,
): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO paper_portfolios(
      name, strategy_id, strategy_version, starting_capital,
      position_sizing, position_size, max_positions,
      max_exposure_per_token, max_total_exposure
    ) VALUES (
      ${opts.name}, ${opts.strategy_id}, ${opts.strategy_version},
      ${opts.starting_capital}, ${opts.position_sizing}, ${opts.position_size},
      ${opts.max_positions}, ${opts.max_exposure_per_token}, ${opts.max_total_exposure}
    )
    ON CONFLICT(name) DO UPDATE SET
      strategy_version = EXCLUDED.strategy_version,
      position_size = EXCLUDED.position_size
    RETURNING id
  `);
  return Number(asRows<{ id: number }>(result)[0]!.id);
}

export async function listPortfolios(db: AppDb): Promise<PaperPortfolio[]> {
  return asRows<PaperPortfolio>(
    await db.execute(
      sql`SELECT * FROM paper_portfolios WHERE archived_at IS NULL ORDER BY id`,
    ),
  );
}

// ----------------------------------------------------------------
// Position management
// ----------------------------------------------------------------
export async function openPosition(
  db: AppDb,
  opts: {
    portfolioId: number;
    signalId: number;
    mint: string;
    entryAt: Date;
    quotePrice: number;
    slippagePct?: number;
    feePct?: number;
    sizeUsd: number;
  },
): Promise<number> {
  const slippage = opts.slippagePct ?? 0.5;
  const fee = opts.feePct ?? 0.1;
  const fillPrice = opts.quotePrice * (1 + slippage / 100);
  const result = await db.execute(sql`
    INSERT INTO paper_positions(
      portfolio_id, signal_id, mint, entry_at,
      entry_quote_price, entry_fill_price,
      entry_slippage_pct, entry_fee_pct, size_usd,
      peak_price, peak_at
    ) VALUES (
      ${opts.portfolioId}, ${opts.signalId}, ${opts.mint}, ${opts.entryAt},
      ${opts.quotePrice}, ${fillPrice},
      ${slippage}, ${fee}, ${opts.sizeUsd},
      ${fillPrice}, ${opts.entryAt}
    )
    RETURNING id
  `);
  return Number(asRows<{ id: number }>(result)[0]!.id);
}

export async function closePosition(
  db: AppDb,
  positionId: number,
  opts: {
    exitAt: Date;
    quotePrice: number;
    slippagePct?: number;
    feePct?: number;
    reason: PaperPosition["exit_reason"];
  },
): Promise<void> {
  const slippage = opts.slippagePct ?? 0.5;
  const fee = opts.feePct ?? 0.1;
  const fillPrice = opts.quotePrice * (1 - slippage / 100);
  await db.execute(sql`
    UPDATE paper_positions SET
      exit_at = ${opts.exitAt},
      exit_quote_price = ${opts.quotePrice},
      exit_fill_price = ${fillPrice},
      exit_slippage_pct = ${slippage},
      exit_fee_pct = ${fee},
      exit_reason = ${opts.reason},
      realised_pnl_usd = size_usd * (${fillPrice} / entry_fill_price - 1) - size_usd * ${fee} / 100,
      realised_pnl_pct = 100 * (${fillPrice} / entry_fill_price - 1) - ${fee},
      status = 'closed'
    WHERE id = ${positionId} AND status = 'open'
  `);
}

export async function updatePositionPeak(
  db: AppDb,
  positionId: number,
  currentPrice: number,
  at: Date,
): Promise<void> {
  await db.execute(sql`
    UPDATE paper_positions SET
      peak_price = GREATEST(peak_price, ${currentPrice}),
      peak_at = CASE WHEN ${currentPrice} > peak_price THEN ${at} ELSE peak_at END,
      mfe_pct = GREATEST(COALESCE(mfe_pct, 0), 100*(${currentPrice}/entry_fill_price - 1)),
      mae_pct = LEAST(COALESCE(mae_pct, 0), 100*(${currentPrice}/entry_fill_price - 1))
    WHERE id = ${positionId} AND status = 'open'
  `);
}

export async function listOpenPositions(
  db: AppDb,
  portfolioId: number,
): Promise<PaperPosition[]> {
  return asRows<PaperPosition>(
    await db.execute(
      sql`SELECT * FROM paper_positions WHERE portfolio_id=${portfolioId} AND status='open' ORDER BY entry_at`,
    ),
  );
}

// ----------------------------------------------------------------
// Equity snapshot
// ----------------------------------------------------------------
export async function upsertEquitySnapshot(
  db: AppDb,
  portfolioId: number,
  date: string, // YYYY-MM-DD
  cash: number,
  openValue: number,
  realisedPnl: number,
  unrealisedPnl: number,
  peakEquity: number,
): Promise<void> {
  const equity = cash + openValue;
  const drawdown = peakEquity > 0 ? 100 * (equity - peakEquity) / peakEquity : 0;
  await db.execute(sql`
    INSERT INTO paper_equity_snapshots(
      portfolio_id, snapshot_date, cash, open_positions_value,
      equity, realised_pnl_usd, unrealised_pnl_usd,
      drawdown_pct, peak_equity
    ) VALUES (
      ${portfolioId}, ${date}::date, ${cash}, ${openValue},
      ${equity}, ${realisedPnl}, ${unrealisedPnl},
      ${drawdown}, ${peakEquity}
    )
    ON CONFLICT(portfolio_id, snapshot_date) DO UPDATE SET
      cash = EXCLUDED.cash,
      open_positions_value = EXCLUDED.open_positions_value,
      equity = EXCLUDED.equity,
      realised_pnl_usd = EXCLUDED.realised_pnl_usd,
      unrealised_pnl_usd = EXCLUDED.unrealised_pnl_usd,
      drawdown_pct = EXCLUDED.drawdown_pct,
      peak_equity = EXCLUDED.peak_equity
  `);
}

export async function getEquityCurve(
  db: AppDb,
  portfolioId: number,
): Promise<Array<Record<string, unknown>>> {
  return asRows(
    await db.execute(
      sql`SELECT snapshot_date, equity, cash, open_positions_value,
          realised_pnl_usd, unrealised_pnl_usd, drawdown_pct, peak_equity
        FROM paper_equity_snapshots
        WHERE portfolio_id = ${portfolioId}
        ORDER BY snapshot_date`,
    ),
  );
}

// ----------------------------------------------------------------
// Drawdown episode helpers
// ----------------------------------------------------------------
export async function upsertDrawdownEpisode(
  db: AppDb,
  alertId: number,
  opts: {
    highObservedAt: Date;
    highValue: number;
    highConfidence?: number | null;
    highLiqUsd?: number | null;
    highVolM5?: number | null;
    troughObservedAt?: Date | null;
    troughValue?: number | null;
    troughLiqUsd?: number | null;
    troughVolM5?: number | null;
    depthPct?: number | null;
    minutesToTrough?: number | null;
  },
): Promise<number> {
  // Find or create an open episode that started at or after highObservedAt
  const existing = asRows<{ id: number }>(
    await db.execute(sql`
      SELECT id FROM paper_drawdown_episodes
      WHERE alert_id = ${alertId} AND resolved_at IS NULL
      ORDER BY high_observed_at DESC LIMIT 1
    `),
  );
  if (existing[0]) return Number(existing[0].id);

  const result = await db.execute(sql`
    INSERT INTO paper_drawdown_episodes(
      alert_id, high_observed_at, high_value,
      high_confidence, high_liq_usd, high_vol_m5,
      trough_observed_at, trough_value, trough_liq_usd, trough_vol_m5,
      depth_pct, minutes_to_trough
    ) VALUES (
      ${alertId}, ${opts.highObservedAt}, ${opts.highValue},
      ${opts.highConfidence ?? null}, ${opts.highLiqUsd ?? null}, ${opts.highVolM5 ?? null},
      ${opts.troughObservedAt ?? null}, ${opts.troughValue ?? null},
      ${opts.troughLiqUsd ?? null}, ${opts.troughVolM5 ?? null},
      ${opts.depthPct ?? null}, ${opts.minutesToTrough ?? null}
    )
    RETURNING id
  `);
  return Number(asRows<{ id: number }>(result)[0]!.id);
}

/** Summary of all drawdown episodes for the stats dashboard */
export async function drawdownEpisodeSummary(db: AppDb): Promise<Array<Record<string, unknown>>> {
  return asRows(
    await db.execute(sql`
      SELECT
        count(*)::int AS total_episodes,
        count(*) FILTER(WHERE resolved_at IS NOT NULL)::int AS resolved,
        count(*) FILTER(WHERE episode_failed = true)::int AS failed,
        count(*) FILTER(WHERE local_high_recovered_at IS NOT NULL)::int AS recovered_to_high,
        count(*) FILTER(WHERE new_ath_at IS NOT NULL)::int AS new_ath,
        avg(depth_pct) AS avg_depth_pct,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY depth_pct) AS median_depth_pct,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes_to_trough) AS median_minutes_to_trough,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY rebound_pct) FILTER(WHERE rebound_pct IS NOT NULL) AS median_rebound_pct
      FROM paper_drawdown_episodes
    `),
  );
}
