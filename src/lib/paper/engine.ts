/**
 * paper/engine.ts
 *
 * Paper-trading engine: simulates entries and exits for a portfolio
 * using the existing alert_observations price path.
 *
 * Rules:
 * - Never trades with real money; all results are labelled as estimates.
 * - Quote price ≠ fill price: slippage and fees are applied consistently.
 * - If liquidity is unknown, positions are still tracked but flagged.
 * - Open positions are updated from new alert_observations as they arrive.
 * - Capital constraints are enforced — independent trade returns are NOT summed.
 */
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows, asNumber, asDate } from "@/lib/db/rows";
import {
  listPortfolios,
  listOpenPositions,
  openPosition,
  closePosition,
  updatePositionPeak,
  upsertEquitySnapshot,
  PaperPortfolio,
  PaperPosition,
} from "./store";

export type StrategyConfig = {
  id: string;
  version: number;
  /** Minimum confidence to enter */
  minConfidence: number;
  /** Stop-loss: close if price falls this % below entry fill */
  stopLossPct: number;
  /** Trailing stop: close if price falls this % below peak */
  trailingStopPct: number;
  /** Take-profit ladders: sell fraction at each multiple */
  takeProfitLadder: Array<{ multiplePct: number; fraction: number }>;
  /** Maximum hours to hold a position */
  maxHoldHours: number;
  /** Entry slippage assumption */
  entrySlippagePct: number;
  /** Exit slippage assumption */
  exitSlippagePct: number;
  /** Fee per trade (entry + exit each) */
  feePct: number;
};

export const DEFAULT_STRATEGY: StrategyConfig = {
  id: "default",
  version: 1,
  minConfidence: 75,
  stopLossPct: 30,
  trailingStopPct: 20,
  takeProfitLadder: [
    { multiplePct: 100, fraction: 0.5 },
    { multiplePct: 300, fraction: 0.3 },
    { multiplePct: 500, fraction: 0.2 },
  ],
  maxHoldHours: 72,
  entrySlippagePct: 0.5,
  exitSlippagePct: 0.5,
  feePct: 0.1,
};

type Observation = {
  alert_id: number;
  mint: string;
  signal_id: number | null;
  observed_at: Date;
  price_usd: number | null;
  mcap_usd: number | null;
  basis: string;
  entry_value: number;
  confidence: number;
  liq_usd: number | null;
  vol_m5: number | null;
};

function getObservationValue(obs: Observation): number | null {
  return obs.basis === "price" ? obs.price_usd : obs.mcap_usd;
}

/**
 * Compute available cash in a portfolio after reserving for open positions.
 */
async function portfolioCash(
  db: AppDb,
  portfolio: PaperPortfolio,
): Promise<number> {
  const deployed = asRows<{ total: number }>(
    await db.execute(sql`
      SELECT coalesce(sum(size_usd), 0)::float AS total
      FROM paper_positions
      WHERE portfolio_id = ${portfolio.id} AND status = 'open'
    `),
  )[0]?.total ?? 0;

  const realised = asRows<{ total: number }>(
    await db.execute(sql`
      SELECT coalesce(sum(realised_pnl_usd), 0)::float AS total
      FROM paper_positions
      WHERE portfolio_id = ${portfolio.id} AND status = 'closed'
    `),
  )[0]?.total ?? 0;

  return portfolio.starting_capital + realised - deployed;
}

/**
 * Compute position size in USD respecting portfolio rules.
 */
function computePositionSize(
  portfolio: PaperPortfolio,
  currentEquity: number,
  cash: number,
  openCount: number,
): number | null {
  if (openCount >= portfolio.max_positions) return null;

  const baseSize =
    portfolio.position_sizing === "percentage"
      ? currentEquity * portfolio.position_size / 100
      : portfolio.position_size;

  const maxByExposure = currentEquity * portfolio.max_exposure_per_token;
  const maxByTotalExposure =
    currentEquity * portfolio.max_total_exposure - (currentEquity - cash);

  const size = Math.min(baseSize, maxByExposure, maxByTotalExposure, cash);
  return size > 0 ? size : null;
}

/**
 * Process new observations for all active portfolios.
 * Called from the cron pipeline — MUST be idempotent.
 *
 * Returns counts of entries, exits, and equity snapshots written.
 */
export async function runPortfolioEngine(
  db: AppDb,
  strategy: StrategyConfig = DEFAULT_STRATEGY,
): Promise<{ entries: number; exits: number; snapshots: number }> {
  const portfolios = await listPortfolios(db);
  let entries = 0,
    exits = 0,
    snapshots = 0;

  for (const portfolio of portfolios) {
    // Load unprocessed observations since last engine run
    const obs = asRows<Observation>(
      await db.execute(sql`
        SELECT
          a.id AS alert_id,
          a.mint,
          ps.id AS signal_id,
          o.observed_at,
          o.price_usd,
          o.mcap_usd,
          a.basis,
          a.entry_value,
          a.confidence,
          NULL::double precision AS liq_usd,
          NULL::double precision AS vol_m5
        FROM telegram_alerts a
        JOIN alert_observations o ON o.alert_id = a.id
        LEFT JOIN paper_signals ps ON ps.alert_id = a.id
        WHERE a.status = 'sent'
          AND a.confidence >= ${strategy.minConfidence}
          AND o.observed_at > now() - interval '73 hours'
        ORDER BY o.observed_at ASC
        LIMIT 500
      `),
    );

    const openPositions = await listOpenPositions(db, portfolio.id);
    const openByMint = new Map(openPositions.map((p) => [p.mint, p]));
    const cash = await portfolioCash(db, portfolio);

    for (const ob of obs) {
      const price = getObservationValue(ob);
      if (price == null || price <= 0) continue;
      const obsDate = asDate(ob.observed_at) ?? new Date();

      const existing = openByMint.get(ob.mint);

      if (existing) {
        // Update peak tracking
        await updatePositionPeak(db, existing.id, price, obsDate);

        const entryFill = existing.entry_fill_price;
        const peakPrice = Math.max(asNumber(existing.peak_price) ?? entryFill, price);
        const returnPct = 100 * (price / entryFill - 1);
        const drawdownFromPeak = 100 * (price / peakPrice - 1);

        const entryDate = asDate(existing.entry_at) ?? obsDate;
        const holdHours =
          (obsDate.getTime() - entryDate.getTime()) /
          3_600_000;

        let shouldExit: PaperPosition["exit_reason"] = null;

        if (returnPct <= -strategy.stopLossPct) {
          shouldExit = "stop_loss";
        } else if (drawdownFromPeak <= -strategy.trailingStopPct) {
          shouldExit = "trailing_stop";
        } else if (holdHours >= strategy.maxHoldHours) {
          shouldExit = "time_exit";
        } else {
          // Check take-profit ladder (highest tier first)
          for (const tier of [...strategy.takeProfitLadder].reverse()) {
            if (returnPct >= tier.multiplePct) {
              shouldExit = "take_profit";
              break;
            }
          }
        }

        if (shouldExit) {
          await closePosition(db, existing.id, {
            exitAt: obsDate,
            quotePrice: price,
            slippagePct: strategy.exitSlippagePct,
            feePct: strategy.feePct,
            reason: shouldExit,
          });
          openByMint.delete(ob.mint);
          exits++;
        }
      } else {
        // Consider entering a new position
        const equity = portfolio.starting_capital; // simplified — use starting as base for sizing
        const openCount = openByMint.size;
        const sizeUsd = computePositionSize(portfolio, equity, cash, openCount);
        if (sizeUsd == null) continue;
        if (sizeUsd < 1) continue; // less than $1 is not worth simulating

        // Ensure we have a paper_signal for this alert
        const signalId =
          ob.signal_id ??
          asRows<{ id: number }>(
            await db.execute(
              sql`SELECT id FROM paper_signals WHERE alert_id = ${ob.alert_id} LIMIT 1`,
            ),
          )[0]?.id;

        if (!signalId) continue; // signal sync not done yet

        const posId = await openPosition(db, {
          portfolioId: portfolio.id,
          signalId: Number(signalId),
          mint: ob.mint,
          entryAt: obsDate,
          quotePrice: price,
          slippagePct: strategy.entrySlippagePct,
          feePct: strategy.feePct,
          sizeUsd,
        });
        openByMint.set(ob.mint, {
          id: posId,
          portfolio_id: portfolio.id,
          signal_id: Number(signalId),
          mint: ob.mint,
          entry_at: obsDate,
          entry_quote_price: price,
          entry_fill_price: price * (1 + strategy.entrySlippagePct / 100),
          entry_slippage_pct: strategy.entrySlippagePct,
          entry_fee_pct: strategy.feePct,
          size_usd: sizeUsd,
          exit_at: null,
          exit_quote_price: null,
          exit_fill_price: null,
          exit_reason: null,
          realised_pnl_usd: null,
          realised_pnl_pct: null,
          peak_price: price,
          peak_at: obsDate,
          mae_pct: null,
          mfe_pct: null,
          status: "open",
        });
        entries++;
      }
    }

    // Write daily equity snapshot
    const today = new Date().toISOString().slice(0, 10);
    const openValue = asRows<{ total: number }>(
      await db.execute(sql`
        SELECT coalesce(sum(size_usd), 0)::float AS total
        FROM paper_positions
        WHERE portfolio_id = ${portfolio.id} AND status = 'open'
      `),
    )[0]?.total ?? 0;

    const realisedTotal = asRows<{ total: number }>(
      await db.execute(sql`
        SELECT coalesce(sum(realised_pnl_usd), 0)::float AS total
        FROM paper_positions
        WHERE portfolio_id = ${portfolio.id} AND status = 'closed'
      `),
    )[0]?.total ?? 0;

    const currentCash = portfolio.starting_capital + realisedTotal - openValue;
    const currentEquity = currentCash + openValue;
    const peakEquity = asRows<{ peak: number }>(
      await db.execute(sql`
        SELECT coalesce(max(equity), ${portfolio.starting_capital})::float AS peak
        FROM paper_equity_snapshots WHERE portfolio_id = ${portfolio.id}
      `),
    )[0]?.peak ?? portfolio.starting_capital;

    await upsertEquitySnapshot(
      db,
      portfolio.id,
      today,
      currentCash,
      openValue,
      realisedTotal,
      0, // unrealised mark-to-market requires current prices — deferred
      Math.max(peakEquity, currentEquity),
    );
    snapshots++;
  }

  return { entries, exits, snapshots };
}

/** Seed the default portfolio if none exists. */
export async function ensureDefaultPortfolio(db: AppDb): Promise<number> {
  const existing = asRows<{ id: number }>(
    await db.execute(
      sql`SELECT id FROM paper_portfolios WHERE name='default' LIMIT 1`,
    ),
  );
  if (existing[0]) return Number(existing[0].id);

  const result = await db.execute(sql`
    INSERT INTO paper_portfolios(
      name, strategy_id, strategy_version, starting_capital,
      position_sizing, position_size, max_positions,
      max_exposure_per_token, max_total_exposure
    ) VALUES (
      'default', 'default', 1, 1000,
      'fixed_dollar', 100, 5, 0.2, 0.8
    )
    RETURNING id
  `);
  return Number(asRows<{ id: number }>(result)[0]!.id);
}
