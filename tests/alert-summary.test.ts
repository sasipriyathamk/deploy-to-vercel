import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  it,
  expect,
  vi,
} from "vitest";
import * as schema from "@/lib/db/schema";
import { applyMigrations } from "@/lib/db/migrate";
import { alertSummary } from "@/lib/alerts/summary";
import { recordObservation } from "@/lib/alerts/store";
import { runAlertWorker } from "@/lib/alerts/worker";
const client = new PGlite();
const db = drizzle(client, { schema });
beforeAll(async () => {
  vi.stubEnv("ALLOW_ALERT_MIGRATIONS", "1");
  await applyMigrations(db);
}, 30000);
beforeEach(async () => {
  vi.stubEnv("TELEGRAM_ALERTS_ENABLED", "0");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("TELEGRAM_CHAT_ID", "");
  vi.stubEnv("CRON_SECRET", "");
  await db.execute(
    sql`TRUNCATE telegram_alert_milestones,alert_observations,telegram_alerts,tokens,token_checks,pipeline_runs RESTART IDENTITY`,
  );
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => client.close());
it("reports schema readiness and real zero counts without treating configuration as delivered alerts", async () => {
  const data = await alertSummary(db);
  expect(data.configuration).toEqual({
    enabled: false,
    botConfigured: false,
    chatConfigured: false,
    workerSecretConfigured: false,
    schemaReady: true,
  });
  expect(data.delivery?.sent).toBe(0);
  expect(data.performance).toMatchObject({
    covered: 0,
    unobserved: 0,
    meanReturn: null,
    worstDrawdown: null,
  });
  expect(data.milestones.map((m) => m.multiple)).toEqual([2, 3, 5, 10]);
  expect(data.recent).toEqual([]);
  expect(data.lastWorkerAt).toBeNull();
});
it("reports missing storage without querying absent tables or inventing delivery totals", async () => {
  const other = new PGlite();
  const local = drizzle(other, { schema });
  try {
    vi.stubEnv("ALLOW_ALERT_MIGRATIONS", "0");
    await applyMigrations(local);
    await local.execute(
      sql`INSERT INTO tokens(mint,status,score,confidence) VALUES ('qualifying','watching',100,75)`,
    );
    const data = await alertSummary(local);
    expect(data.configuration.schemaReady).toBe(false);
    expect(data.qualifyingTokens).toBe(1);
    expect(data.delivery).toBeNull();
    expect(data.performance).toBeNull();
    expect(data.milestones).toEqual([]);
  } finally {
    await other.close();
  }
});
it("shows fixed-baseline alert outcomes and milestones while excluding sensitive records", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fake-private-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "fake-private-chat");
  vi.stubEnv("CRON_SECRET", "fake-private-cron");
  await db.execute(
    sql`INSERT INTO tokens(mint,symbol,status,score,confidence) VALUES ('reference','REF','watching',100,80),('unobserved','NONE','watching',100,75)`,
  );
  const snapshot = {
    token: { symbol: "REF", privatePayload: "NOT_FOR_PUBLIC_SUMMARY" },
    ai: { reasoning: "PRIVATE_AI_CONTENT" },
    event: { privateDetails: "NOT_FOR_PUBLIC_SUMMARY" },
    market: { priceUsd: 100, mcapUsd: 1000 },
  };
  await db.execute(sql`INSERT INTO telegram_alerts(mint,qualified_at,snapshot_at,confidence,stage,snapshot,basis,entry_value,status,sent_at,telegram_message_id)
 VALUES ('reference',now()-interval '3 hours',now()-interval '3 hours',80,'t0',${JSON.stringify(snapshot)}::jsonb,'price',100,'sent',now()-interval '3 hours',1),
 ('unobserved',now()-interval '2 hours',now()-interval '2 hours',75,'t0',${JSON.stringify(snapshot)}::jsonb,'mcap',1000,'sent',now()-interval '2 hours',2)`);
  for (const [i, value] of [120, 90, 200].entries())
    await recordObservation(
      db,
      1,
      `quote:${i}`,
      new Date(Date.now() - (150 - i * 10) * 60000),
      "gain_refresh",
      { ...snapshot, market: { priceUsd: value, mcapUsd: 1000 } },
    );
  const data = await alertSummary(db);
  expect(data.delivery?.sent).toBe(2);
  expect(data.performance).toMatchObject({
    covered: 1,
    unobserved: 1,
    aboveBaseline: 1,
  });
  expect(data.performance?.meanReturn).toBeCloseTo(100);
  expect(data.performance?.worstDrawdown).toBeCloseTo(-25);
  const ref = data.recent.find((r) => r.mint === "reference")!;
  expect(ref.latestReturn).toBeCloseTo(100);
  expect(ref.drawdown).toBeCloseTo(-25);
  expect(ref.milestones).toEqual([2]);
  expect(
    data.recent.find((r) => r.mint === "unobserved")?.latestReturn,
  ).toBeNull();
  const json = JSON.stringify(data);
  for (const secret of [
    "fake-private-token",
    "fake-private-chat",
    "fake-private-cron",
    "NOT_FOR_PUBLIC_SUMMARY",
    "PRIVATE_AI_CONTENT",
  ])
    expect(json).not.toContain(secret);
  expect(data.configuration.botConfigured).toBe(true);
  expect(data.lastSentAt).not.toBeNull();
});
it("records worker activity without claiming that a message was delivered", async () => {
  vi.stubEnv("TELEGRAM_ALERTS_ENABLED", "1");
  const load = vi.fn();
  const fetcher = vi.fn();
  await runAlertWorker(db, { load, fetcher });
  const data = await alertSummary(db);
  expect(data.lastWorkerAt).not.toBeNull();
  expect(data.lastWorkerFinishedAt).not.toBeNull();
  expect(data.delivery?.sent).toBe(0);
  expect(data.lastSentAt).toBeNull();
  expect(load).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
