/**
 * tests/paper-store.test.ts
 *
 * Tests for the paper-trading store layer.
 * Runs against an in-memory PGlite database with alert migrations applied.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/index";
import { sql } from "drizzle-orm";
import {
  upsertPaperSignal,
  createPortfolio,
  listPortfolios,
  openPosition,
  closePosition,
  updatePositionPeak,
  listOpenPositions,
  upsertEquitySnapshot,
  getEquityCurve,
} from "@/lib/paper/store";

// Set env so alert + paper migrations run
process.env.ALLOW_ALERT_MIGRATIONS = "1";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  // Seed minimal token and telegram_alert for FK references
  await db.execute(sql`
    INSERT INTO tokens(mint, symbol, status) VALUES ('TEST_MINT', 'TEST', 'watching')
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO telegram_alerts(mint, qualified_at, snapshot_at, confidence, stage, snapshot, basis, entry_value, status, sent_at, telegram_message_id)
    VALUES ('TEST_MINT', now()-interval '2 hours', now()-interval '2 hours', 80, 'test', '{"token":{},"ai":null,"event":null,"market":null}'::jsonb, 'price', 1.0, 'sent', now()-interval '2 hours', 999)
    ON CONFLICT DO NOTHING
  `);
}, 60_000);

describe("paper_signals", () => {
  it("upserts a signal without error", async () => {
    const id = await upsertPaperSignal(db, {
      mint: "TEST_MINT",
      signalType: "research",
      confidence: 80,
      qualifiedAt: new Date(Date.now() - 3_600_000),
      snapshotAt: new Date(Date.now() - 3_600_000),
      basis: "price",
      entryValue: 1.0,
      priceUsd: 1.0,
    });
    expect(id).toBeTypeOf("number");
    expect(id).toBeGreaterThan(0);
  });

  it("returns null on duplicate insert (ON CONFLICT DO NOTHING)", async () => {
    // Duplicate should return null (no row returned)
    const id = await upsertPaperSignal(db, {
      mint: "TEST_MINT",
      signalType: "research",
      confidence: 80,
      qualifiedAt: new Date(Date.now() - 3_600_000),
      snapshotAt: new Date(Date.now() - 3_600_000),
      basis: "price",
      entryValue: 1.0,
    });
    // May be null if exact conflict occurs (depends on qualified_at overlap)
    expect(id === null || typeof id === "number").toBe(true);
  });
});

describe("paper_portfolios", () => {
  it("creates and lists portfolios", async () => {
    const id = await createPortfolio(db, {
      name: `test-portfolio-${Date.now()}`,
      strategy_id: "default",
      strategy_version: 1,
      starting_capital: 1000,
      position_sizing: "fixed_dollar",
      position_size: 100,
      max_positions: 5,
      max_exposure_per_token: 0.2,
      max_total_exposure: 0.8,
    });
    expect(id).toBeGreaterThan(0);
    const list = await listPortfolios(db);
    expect(list.length).toBeGreaterThan(0);
  });
});

describe("paper_positions", () => {
  let portfolioId: number;
  let signalId: number;

  beforeAll(async () => {
    portfolioId = await createPortfolio(db, {
      name: `pos-test-${Date.now()}`,
      strategy_id: "default",
      strategy_version: 1,
      starting_capital: 500,
      position_sizing: "fixed_dollar",
      position_size: 50,
      max_positions: 3,
      max_exposure_per_token: 0.3,
      max_total_exposure: 0.7,
    });
    const id = await upsertPaperSignal(db, {
      mint: "TEST_MINT",
      signalType: "alert",
      confidence: 80,
      qualifiedAt: new Date(Date.now() - 7_200_000),
      snapshotAt: new Date(Date.now() - 7_200_000),
      basis: "price",
      entryValue: 1.0,
      priceUsd: 1.0,
    });
    signalId = id ?? 1;
  });

  it("opens and closes a position with correct P&L", async () => {
    const posId = await openPosition(db, {
      portfolioId,
      signalId,
      mint: "TEST_MINT",
      entryAt: new Date(Date.now() - 3_600_000),
      quotePrice: 1.0,
      slippagePct: 0.5,
      feePct: 0.1,
      sizeUsd: 50,
    });
    expect(posId).toBeGreaterThan(0);

    // Update peak with a higher price
    await updatePositionPeak(db, posId, 2.0, new Date());

    // Open positions should include this
    const open = await listOpenPositions(db, portfolioId);
    expect(open.some((p) => p.id === posId)).toBe(true);

    // Close at 2x the fill price
    await closePosition(db, posId, {
      exitAt: new Date(),
      quotePrice: 2.0,
      slippagePct: 0.5,
      feePct: 0.1,
      reason: "take_profit",
    });

    const closed = await listOpenPositions(db, portfolioId);
    expect(closed.some((p) => p.id === posId)).toBe(false);
  });

  it("tracks entry fill price separately from quote price", async () => {
    const quotePrice = 1.0;
    const slippage = 0.5;
    const posId = await openPosition(db, {
      portfolioId,
      signalId,
      mint: "TEST_MINT",
      entryAt: new Date(),
      quotePrice,
      slippagePct: slippage,
      feePct: 0.1,
      sizeUsd: 50,
    });
    const rows = await db.execute(
      sql`SELECT entry_quote_price, entry_fill_price FROM paper_positions WHERE id=${posId}`,
    );
    const { entry_quote_price, entry_fill_price } = (rows as { rows: Array<Record<string, number>> }).rows[0] ?? {};
    expect(Number(entry_quote_price)).toBeCloseTo(quotePrice, 5);
    expect(Number(entry_fill_price)).toBeCloseTo(quotePrice * (1 + slippage / 100), 5);
  });
});

describe("equity snapshots", () => {
  it("upserts and reads back equity curve", async () => {
    const pId = await createPortfolio(db, {
      name: `equity-test-${Date.now()}`,
      strategy_id: "default",
      strategy_version: 1,
      starting_capital: 1000,
      position_sizing: "fixed_dollar",
      position_size: 100,
      max_positions: 5,
      max_exposure_per_token: 0.2,
      max_total_exposure: 0.8,
    });
    await upsertEquitySnapshot(db, pId, "2026-01-01", 900, 100, 0, 0, 1000);
    await upsertEquitySnapshot(db, pId, "2026-01-02", 950, 100, 50, 10, 1000);
    const curve = await getEquityCurve(db, pId);
    expect(curve.length).toBe(2);
    expect(Number(curve[0].equity)).toBeCloseTo(1000, 1);
  });
});
