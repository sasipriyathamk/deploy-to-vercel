import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  it,
  expect,
  vi,
} from "vitest";
import * as schema from "@/lib/db/schema";
import { applyMigrations } from "@/lib/db/migrate";
import { asRows } from "@/lib/db/rows";
import {
  captureObservation,
  claimDelivery,
  markDelivery,
  recordObservation,
  snapshotFor,
} from "@/lib/alerts/store";
import {
  claimMilestone,
  listMilestones,
  milestoneStats,
} from "@/lib/alerts/milestones";
import {
  deliverPendingMilestones,
  deliverNotifications,
} from "@/lib/alerts/telegram";
import { runAlertWorker } from "@/lib/alerts/worker";
import { emptySnapshot } from "@/lib/market";
const client = new PGlite();
const db = drizzle(client, { schema });
const mint = "milestone-token";
const market = {
  ...emptySnapshot("dexscreener"),
  priceUsd: 100,
  mcapUsd: 1000,
  liqUsd: 5000,
};
async function initial(basis: "price" | "mcap" = "price") {
  await db.execute(
    sql`INSERT INTO tokens(mint,symbol,status,score,confidence) VALUES (${mint},'TEST','watching',100,75)`,
  );
  await captureObservation(
    db,
    mint,
    "initial",
    new Date(),
    "t0",
    {},
    basis === "price" ? market : { ...market, priceUsd: null },
  );
  const a = await claimDelivery(db);
  await markDelivery(db, Number(a!.id), "sent", 1, null);
  return Number(a!.id);
}
async function observe(
  id: number,
  value: number | null,
  key: string,
  basis: "price" | "mcap" = "price",
  at = new Date(),
) {
  const quote =
    basis === "price"
      ? { ...market, priceUsd: value }
      : { ...market, priceUsd: 999999, mcapUsd: value };
  const snapshot = (await snapshotFor(db, mint, {}, quote))!;
  await recordObservation(db, id, key, at, "gain_refresh", snapshot);
}
function credentials() {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:mock-only");
  vi.stubEnv("TELEGRAM_CHAT_ID", "-100123");
}
const ok = () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 22 } }), {
    status: 200,
  });
beforeAll(async () => {
  vi.stubEnv("ALLOW_ALERT_MIGRATIONS", "1");
  await applyMigrations(db);
}, 30000);
beforeEach(async () => {
  vi.stubEnv("TELEGRAM_ALERTS_ENABLED", "1");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("TELEGRAM_CHAT_ID", "");
  await db.execute(
    sql`TRUNCATE telegram_alert_milestones,alert_observations,telegram_alerts,tokens,token_checks RESTART IDENTITY`,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => client.close());
it("records exact 2x, 3x, 5x and 10x thresholds once, preserving first reach evidence", async () => {
  const id = await initial();
  await observe(id, 199.99, "below");
  expect(await listMilestones(db, id)).toEqual([]);
  for (const value of [200, 300, 500, 1000])
    await observe(id, value, `value:${value}`);
  await observe(id, 150, "dip");
  await observe(id, 1500, "again");
  const rows = await listMilestones(db, id);
  expect(rows.map((m) => m.multiple)).toEqual([2, 3, 5, 10]);
  expect(rows.map((m) => m.observed_value)).toEqual([200, 300, 500, 1000]);
  expect(
    (rows[0].snapshot as { market: { priceUsd: number } }).market.priceUsd,
  ).toBe(200);
});
it("captures all crossed levels on a jump and reports the actual sampled value", async () => {
  const id = await initial();
  await observe(id, 650, "jump");
  const rows = await listMilestones(db, id);
  expect(rows.map((m) => m.multiple)).toEqual([2, 3, 5]);
  expect(rows.every((m) => m.observed_value === 650)).toBe(true);
});
it("uses the original market-cap basis rather than a later available price", async () => {
  const id = await initial("mcap");
  await observe(id, 1500, "below", "mcap");
  expect(await listMilestones(db, id)).toEqual([]);
  await observe(id, 2000, "hit", "mcap");
  expect((await listMilestones(db, id)).map((m) => m.multiple)).toEqual([2]);
});
it("ignores missing, zero, pre-send, context-only and future quotes", async () => {
  const id = await initial();
  await observe(id, null, "missing");
  await observe(id, 0, "zero");
  await observe(id, 2000, "before", "price", new Date(0));
  await observe(id, 2000, "future", "price", new Date(Date.now() + 3600000));
  const snapshot = (await snapshotFor(db, mint, { ai: "context" }, null))!;
  await recordObservation(
    db,
    id,
    "context",
    new Date(),
    "ai_verdict",
    snapshot,
  );
  expect(await listMilestones(db, id)).toEqual([]);
});
it("does not create milestones until the initial Telegram alert is confirmed", async () => {
  await db.execute(
    sql`INSERT INTO tokens(mint,status,score,confidence) VALUES (${mint},'watching',100,75)`,
  );
  await captureObservation(db, mint, "start", new Date(), "t0", {}, market);
  await observe(1, 2000, "not-sent");
  expect(await listMilestones(db, 1)).toEqual([]);
});
it("continues milestones after confidence falls or the token is archived", async () => {
  const id = await initial();
  await db.execute(sql`UPDATE tokens SET confidence=20,status='archived'`);
  await observe(id, 200, "recovery");
  expect((await listMilestones(db, id)).map((m) => m.multiple)).toEqual([2]);
  expect(await claimDelivery(db)).toBeNull();
});
it("is safe against concurrent duplicate detections and competing delivery workers", async () => {
  const id = await initial();
  await Promise.all([observe(id, 220, "one"), observe(id, 230, "two")]);
  expect(await listMilestones(db, id)).toHaveLength(1);
  const claims = await Promise.all([claimMilestone(db), claimMilestone(db)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
});
it("rolls back the observation as well if its milestone cannot be stored", async () => {
  const id = await initial();
  await db.execute(
    sql`ALTER TABLE telegram_alert_milestones ADD CONSTRAINT test_reject_two CHECK (multiple<>2)`,
  );
  try {
    await expect(observe(id, 200, "atomic")).rejects.toThrow();
    expect(
      asRows(
        await db.execute(
          sql`SELECT id FROM alert_observations WHERE event_key='atomic'`,
        ),
      ),
    ).toHaveLength(0);
  } finally {
    await db.execute(
      sql`ALTER TABLE telegram_alert_milestones DROP CONSTRAINT test_reject_two`,
    );
  }
});
it("sends each milestone once, independently of the initial alert, with clear return math", async () => {
  const id = await initial();
  await observe(id, 225, "two");
  credentials();
  const fetcher = vi.fn().mockResolvedValue(ok());
  expect(await deliverPendingMilestones(db, { fetcher })).toEqual({
    attempted: 1,
    sent: 1,
  });
  expect(await deliverPendingMilestones(db, { fetcher })).toEqual({
    attempted: 0,
    sent: 0,
  });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.text).toContain("🚀 TEST · 2× milestone");
  expect(body.text).toContain("📈 Observed 2.25× (+125.0%)");
  expect(body.text).toContain("↗️ From alert price $100.00");
  expect(body.text).toContain("⏱ ");
  expect(body.text).toContain("🔗 https://gmgn.ai/sol/token/milestone-token");
  expect(body.text).not.toContain("observation #");
  expect(body.text).not.toContain("mock-only");
  expect(body.text.length).toBeLessThanOrEqual(4096);
  const rows = await listMilestones(db, id);
  expect(rows[0].status).toBe("sent");
  expect(rows[0].telegram_message_id).toBe(22);
  const parent = asRows<{ status: string }>(
    await db.execute(sql`SELECT status FROM telegram_alerts`),
  );
  expect(parent[0].status).toBe("sent");
});
it("never retries an ambiguous milestone send, even after another crossing", async () => {
  const id = await initial();
  await observe(id, 200, "first");
  credentials();
  const fetcher = vi.fn().mockRejectedValue(new Error("ambiguous"));
  await deliverPendingMilestones(db, { fetcher });
  await observe(id, 250, "again");
  await deliverPendingMilestones(db, { fetcher });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await listMilestones(db, id))[0].status).toBe("unknown");
});
it("honors rate-limit backoff across initial and milestone notifications", async () => {
  const id = await initial();
  await observe(id, 350, "jump");
  credentials();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, parameters: { retry_after: 7200 } }),
        { status: 429 },
      ),
    )
    .mockResolvedValue(ok());
  expect(
    await deliverNotifications(db, {
      fetcher,
      limit: 3,
      deadline: Date.now() + 45000,
    }),
  ).toMatchObject({ attempted: 1, sent: 0, paused: true });
  expect(await claimMilestone(db)).toBeNull();
  await db.execute(
    sql`INSERT INTO tokens(mint,status,score,confidence) VALUES ('other','watching',100,75)`,
  );
  await captureObservation(db, "other", "new", new Date(), "t0", {}, market);
  expect(await claimDelivery(db)).toBeNull();
  const backoff = asRows<{ seconds: number }>(
    await db.execute(
      sql`SELECT extract(epoch FROM next_attempt_at-now()) AS seconds FROM telegram_alert_milestones WHERE attempts>0`,
    ),
  );
  expect(Number(backoff[0].seconds)).toBeGreaterThan(7100);
  await db.execute(
    sql`UPDATE telegram_alert_milestones SET next_attempt_at=now()-interval '1 second'`,
  );
  await deliverPendingMilestones(db, { fetcher });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("keeps observed reach and notification delivery statistics separate", async () => {
  const id = await initial();
  await observe(id, 350, "reach");
  let stats = await milestoneStats(db);
  expect(stats.map((s) => s.multiple)).toEqual([2, 3, 5, 10]);
  expect(stats[0]).toMatchObject({
    alerts_observed_reaching: 1,
    telegram_notifications_sent: 0,
    notifications_pending: 1,
    total_sent_alerts: 1,
  });
  expect(Number(stats[0].observed_reach_pct_of_sent_alerts)).toBe(100);
  credentials();
  await deliverPendingMilestones(db, {
    fetcher: vi.fn().mockResolvedValue(ok()),
  });
  stats = await milestoneStats(db);
  expect(stats[0].telegram_notifications_sent).toBe(1);
  expect(stats[1].telegram_notifications_sent).toBe(0);
});
it("delivers a milestone created by an hourly sample in the same worker run", async () => {
  const id = await initial();
  await db.execute(
    sql`UPDATE telegram_alerts SET next_snapshot_at=now()-interval '1 hour' WHERE id=${id}`,
  );
  credentials();
  const fetcher = vi.fn().mockResolvedValue(ok());
  const result = await runAlertWorker(db, {
    load: vi.fn().mockResolvedValue({ ...market, priceUsd: 250 }),
    fetcher,
  });
  expect(result).toMatchObject({
    observed: 1,
    initialSent: 0,
    milestonesSent: 1,
    sent: 1,
  });
  expect((await listMilestones(db, id))[0].status).toBe("sent");
});
it("does not start milestone sends without credentials or deadline headroom", async () => {
  const id = await initial();
  await observe(id, 200, "hit");
  const fetcher = vi.fn();
  await deliverPendingMilestones(db, { fetcher });
  credentials();
  await deliverPendingMilestones(db, { fetcher, deadline: Date.now() + 1000 });
  expect(fetcher).not.toHaveBeenCalled();
  expect((await listMilestones(db, id))[0].status).toBe("pending");
});
