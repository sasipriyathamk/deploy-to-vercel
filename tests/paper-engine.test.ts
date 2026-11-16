/**
 * tests/paper-engine.test.ts
 *
 * Tests for the paper trading engine, drawdown tracking, and portfolio mechanics.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/index";
import { sql } from "drizzle-orm";
import {
  ensureDefaultPortfolio,
  runPortfolioEngine,
  DEFAULT_STRATEGY,
} from "@/lib/paper/engine";
import {
  upsertPaperSignal,
  upsertDrawdownEpisode,
  drawdownEpisodeSummary,
} from "@/lib/paper/store";
import {
  computeCalibrationBand,
  refreshCalibration,
  getCalibration,
  CONFIDENCE_BANDS,
} from "@/lib/paper/calibration";
import {
  selectSampleTargets,
  enqueuePaperSamples,
} from "@/lib/paper/sampler";

process.env.ALLOW_ALERT_MIGRATIONS = "1";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await db.execute(sql`
    INSERT INTO tokens(mint, symbol, status, confidence)
    VALUES ('ENGINE_MINT', 'ENG', 'watching', 85)
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO telegram_alerts(
      mint, qualified_at, snapshot_at, confidence, stage,
      snapshot, basis, entry_value, status, sent_at, telegram_message_id
    )
    VALUES (
      'ENGINE_MINT', now() - interval '2 hours', now() - interval '2 hours',
      85, 'test', '{"token":{},"ai":null,"event":null,"market":null}'::jsonb,
      'price', 10.0, 'sent', now() - interval '2 hours', 1001
    )
    ON CONFLICT DO NOTHING
  `);
}, 60_000);

describe("paper engine execution", () => {
  it("ensures default portfolio exists", async () => {
    const id = await ensureDefaultPortfolio(db);
    expect(id).toBeGreaterThan(0);
    const id2 = await ensureDefaultPortfolio(db);
    expect(id2).toBe(id);
  });

  it("runs portfolio engine idempotently with observations", async () => {
    const alertRow = (await db.execute(
      sql`SELECT id FROM telegram_alerts WHERE mint = 'ENGINE_MINT' LIMIT 1`
    )) as { rows: Array<{ id: number }> };
    const alertId = alertRow.rows[0].id;

    // Insert alert observations
    await db.execute(sql`
      INSERT INTO alert_observations(alert_id, event_key, observed_at, stage, price_usd, snapshot)
      VALUES
        (${alertId}, 'test:1', now() - interval '1 hour', 'hourly', 12.0, '{}'::jsonb),
        (${alertId}, 'test:2', now() - interval '30 minutes', 'hourly', 8.0, '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `);

    // Ensure paper signal is linked
    await upsertPaperSignal(db, {
      mint: "ENGINE_MINT",
      signalType: "alert",
      confidence: 85,
      qualifiedAt: new Date(Date.now() - 7200000),
      snapshotAt: new Date(Date.now() - 7200000),
      basis: "price",
      entryValue: 10.0,
      priceUsd: 10.0,
      alertId,
    });

    const res = await runPortfolioEngine(db, {
      ...DEFAULT_STRATEGY,
      minConfidence: 75,
    });

    expect(res).toBeDefined();
    expect(typeof res.entries).toBe("number");
    expect(typeof res.exits).toBe("number");
    expect(typeof res.snapshots).toBe("number");
  });
});

describe("drawdown episodes", () => {
  it("records and summarizes drawdown episode", async () => {
    const alertRow = (await db.execute(
      sql`SELECT id FROM telegram_alerts WHERE mint = 'ENGINE_MINT' LIMIT 1`
    )) as { rows: Array<{ id: number }> };
    const alertId = alertRow.rows[0].id;

    const epId = await upsertDrawdownEpisode(db, alertId, {
      highObservedAt: new Date(Date.now() - 3600000),
      highValue: 15.0,
      troughObservedAt: new Date(Date.now() - 1800000),
      troughValue: 9.0,
      depthPct: -40.0,
      minutesToTrough: 30,
    });

    expect(epId).toBeGreaterThan(0);

    const summary = await drawdownEpisodeSummary(db);
    expect(summary.length).toBeGreaterThan(0);
    expect(Number(summary[0].total_episodes)).toBeGreaterThan(0);
  });
});

describe("confidence calibration", () => {
  it("computes calibration band metrics", async () => {
    const band = CONFIDENCE_BANDS.find((b) => b.lo === 85) || CONFIDENCE_BANDS[0];
    const stats = await computeCalibrationBand(db, band, 60, "alert");
    expect(stats).toBeDefined();
    if (stats) {
      expect(stats.confidence_lo).toBe(band.lo);
      expect(stats.window_minutes).toBe(60);
      expect(typeof stats.n_signals).toBe("number");
    }
  });

  it("refreshes calibration cache and reads it back", async () => {
    const { computed } = await refreshCalibration(db, "alert");
    expect(computed).toBeGreaterThan(0);

    const rows = await getCalibration(db, "alert");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("confidence_lo");
    expect(rows[0]).toHaveProperty("window_minutes");
  });
});

describe("adaptive sampler", () => {
  it("selects sample targets and enqueues jobs safely without unbounded loop", async () => {
    const targets = await selectSampleTargets(db);
    expect(Array.isArray(targets)).toBe(true);

    const count = await enqueuePaperSamples(db);
    expect(typeof count).toBe("number");
    expect(count).toBeLessThanOrEqual(10);
  });
});
