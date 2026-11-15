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
import { insertCheck, insertRawEvent, updateRawFromRpc } from "@/lib/db/repo";
import { asRows } from "@/lib/db/rows";
import {
  captureObservation,
  claimDelivery,
  claimHourly,
  markDelivery,
  recordObservation,
  snapshotFor,
  type AlertRecord,
} from "@/lib/alerts/store";
import { deliverPendingAlerts, alertMessage } from "@/lib/alerts/telegram";
import {
  alertSystemStats,
  performance,
  hourlyPerformance,
} from "@/lib/alerts/stats";
import { runAlertWorker } from "@/lib/alerts/worker";
import { emptySnapshot } from "@/lib/market";

const client = new PGlite();
const db = drizzle(client, { schema });
const mint = "test-mint";
const market = {
  ...emptySnapshot("dexscreener"),
  priceUsd: 100,
  mcapUsd: 1000,
  liqUsd: 5000,
  volH1: 10000,
};
async function seed(confidence = 75, status = "watching") {
  await db.execute(sql`INSERT INTO tokens(mint,symbol,status,score,confidence,last_checked_at,confidence_reasons)
    VALUES (${mint},'TEST',${status},100,${confidence},now(),'["Liquidity holding"]'::jsonb)`);
}
async function check(price = 100, key = "t0") {
  await insertCheck(db, {
    mint,
    stage: key,
    passed: true,
    flags: { evidence: "kept" },
    payload: { snap: { ...market, priceUsd: price } },
    checkedAt: new Date(),
  });
}
async function alerts() {
  return asRows<AlertRecord>(
    await db.execute(sql`SELECT * FROM telegram_alerts ORDER BY id`),
  );
}
async function sent() {
  await seed();
  await check();
  const a = await claimDelivery(db);
  expect(a).not.toBeNull();
  await markDelivery(db, Number(a!.id), "sent", 42, null);
  return (await alerts())[0];
}
function credentials() {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:fake-for-mock-only");
  vi.stubEnv("TELEGRAM_CHAT_ID", "-100123");
}
const ok = () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
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
    sql`TRUNCATE telegram_alert_milestones,alert_observations,telegram_alerts,token_checks,ai_verdicts,raw_events,tokens RESTART IDENTITY`,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => client.close());

it("uses published confidence >=75, not score or an AI verdict", async () => {
  await seed(74);
  await check();
  expect(await alerts()).toHaveLength(0);
  await db.execute(
    sql`UPDATE tokens SET confidence=75,confidence_pending=90 WHERE mint=${mint}`,
  );
  await check();
  expect(await alerts()).toHaveLength(1);
  expect((await alerts())[0].confidence).toBe(75);
});
it("preserves all available trigger evidence and is idempotent for repeated events", async () => {
  await seed();
  await db.execute(
    sql`INSERT INTO ai_verdicts(mint,verdict,inputs_hash,reasoning,trigger) VALUES (${mint},'avoid','test','Thesis evidence','first')`,
  );
  const at = new Date();
  await Promise.all(
    [1, 2].map(() =>
      captureObservation(
        db,
        mint,
        "same-check",
        at,
        "t5",
        { flags: { x: 1 }, payload: { raw: "evidence" } },
        market,
      ),
    ),
  );
  const [a] = await alerts();
  expect(await alerts()).toHaveLength(1);
  expect(a.snapshot.token.score).toBe(100);
  expect(a.snapshot.ai?.reasoning).toBe("Thesis evidence");
  expect(a.snapshot.event).toMatchObject({ payload: { raw: "evidence" } });
  const rows = asRows<Record<string, unknown>>(
    await db.execute(sql`SELECT * FROM alert_observations`),
  );
  expect(rows).toHaveLength(1);
});
it("freezes the latest available AI and token context when claiming delivery", async () => {
  await seed();
  await check();
  await db.execute(sql`INSERT INTO ai_verdicts(mint,verdict,inputs_hash,reasoning,trigger)
    VALUES (${mint},'ok','late-ai','Arrived before send','material_change')`);
  await db.execute(
    sql`UPDATE tokens SET sniper_still_holding=false WHERE mint=${mint}`,
  );
  const alert = await claimDelivery(db);
  expect(alert!.snapshot.ai?.reasoning).toBe("Arrived before send");
  expect(alert!.snapshot.token.sniper_still_holding).toBe(false);
  expect(alert!.entry_value).toBe(100);
});
it("holds pending alerts on weakening and refreshes their quote on a later crossing", async () => {
  await seed();
  await check();
  await db.execute(sql`UPDATE tokens SET confidence=74 WHERE mint=${mint}`);
  await check(90);
  expect((await alerts())[0].status).toBe("waiting");
  expect(await claimDelivery(db)).toBeNull();
  await db.execute(sql`UPDATE tokens SET confidence=80 WHERE mint=${mint}`);
  await check(120, "t15");
  const [a] = await alerts();
  expect(a.entry_value).toBe(120);
  expect(a.status).toBe("pending");
});
it("never re-alerts a delivered mint, including after archive and revival", async () => {
  const a = await sent();
  await db.execute(
    sql`UPDATE tokens SET confidence=90,status='archived' WHERE mint=${mint}`,
  );
  await check(60, "archive");
  await db.execute(sql`UPDATE tokens SET status='watching' WHERE mint=${mint}`);
  await check(180, "revive");
  const [later] = await alerts();
  expect(later.status).toBe("sent");
  expect(later.entry_value).toBe(a.entry_value);
  expect(later.snapshot).toEqual(a.snapshot);
  expect(await claimDelivery(db)).toBeNull();
  expect(
    asRows<Record<string, unknown>>(
      await db.execute(sql`SELECT * FROM alert_observations`),
    ),
  ).toHaveLength(3);
});
it("claims each alert atomically and never reclaims an abandoned send", async () => {
  await seed();
  await check();
  const claims = await Promise.all([claimDelivery(db), claimDelivery(db)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  await db.execute(
    sql`UPDATE telegram_alerts SET attempted_at=now()-interval '1 day'`,
  );
  expect(await claimDelivery(db)).toBeNull();
  const stats = await alertSystemStats(db);
  expect(stats.monitoring).toMatchObject({
    stalled_delivery_needs_reconciliation: 1,
  });
});
it("does not claim without configuration or when disabled", async () => {
  await seed();
  await check();
  const fetcher = vi.fn();
  expect(await deliverPendingAlerts(db, { fetcher })).toEqual({
    attempted: 0,
    sent: 0,
  });
  expect(fetcher).not.toHaveBeenCalled();
  vi.stubEnv("TELEGRAM_ALERTS_ENABLED", "0");
  await check(300);
  expect((await alerts())[0].attempts).toBe(0);
});
it("sends a compact message once while retaining full evidence and its Telegram acknowledgement", async () => {
  await seed();
  await check();
  credentials();
  const fetcher = vi.fn().mockResolvedValue(ok());
  expect(await deliverPendingAlerts(db, { fetcher })).toEqual({
    attempted: 1,
    sent: 1,
  });
  expect(await deliverPendingAlerts(db, { fetcher })).toEqual({
    attempted: 0,
    sent: 0,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.text).toContain("🎯 75/100");
  expect(body.text).toContain("🔗 https://gmgn.ai/sol/token/test-mint");
  expect(body.text).not.toContain("Liquidity holding");
  expect(body.text.length).toBeLessThanOrEqual(4096);
  expect(body.text).not.toContain("fake-for-mock-only");
  const [a] = await alerts();
  expect(a.telegram_message_id).toBe(101);
  expect(a.sent_at).not.toBeNull();
  expect(a.snapshot.token.confidence_reasons).toEqual(["Liquidity holding"]);
  expect(a.snapshot.market?.volH1).toBe(10000);
});
it("does not retry ambiguous transport failures or expose the bot token in the ledger", async () => {
  await seed();
  await check();
  credentials();
  const fetcher = vi
    .fn()
    .mockRejectedValue(
      new Error(
        "https://api.telegram.org/bot123:fake-for-mock-only/sendMessage",
      ),
    );
  await deliverPendingAlerts(db, { fetcher });
  expect((await alerts())[0].status).toBe("unknown");
  await deliverPendingAlerts(db, { fetcher });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await alerts())).not.toContain("fake-for-mock-only");
});
it("retries only an explicit rate-limit rejection after backoff", async () => {
  await seed();
  await check();
  credentials();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, parameters: { retry_after: 7200 } }),
        { status: 429 },
      ),
    )
    .mockResolvedValueOnce(ok());
  await deliverPendingAlerts(db, { fetcher });
  expect((await alerts())[0].status).toBe("pending");
  const backoff = asRows<{ seconds: number }>(
    await db.execute(
      sql`SELECT extract(epoch FROM next_attempt_at-now()) AS seconds FROM telegram_alerts`,
    ),
  );
  expect(Number(backoff[0].seconds)).toBeGreaterThan(7100);
  expect(await claimDelivery(db)).toBeNull();
  await db.execute(
    sql`UPDATE telegram_alerts SET next_attempt_at=now()-interval '1 second'`,
  );
  await deliverPendingAlerts(db, { fetcher });
  expect((await alerts())[0].status).toBe("sent");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([400, 500])(
  "handles HTTP %s conservatively without repeated sends",
  async (status) => {
    await seed();
    await check();
    credentials();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), { status }),
      );
    await deliverPendingAlerts(db, { fetcher });
    expect((await alerts())[0].status).toBe(
      status === 400 ? "failed" : "unknown",
    );
    await deliverPendingAlerts(db, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("does not send a stale pending quote", async () => {
  await seed();
  await check();
  credentials();
  await db.execute(
    sql`UPDATE telegram_alerts SET snapshot_at=now()-interval '10 minutes'`,
  );
  const fetcher = vi.fn();
  await deliverPendingAlerts(db, { fetcher });
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses a fixed alert baseline and peak-to-trough drawdown, not current token gain", async () => {
  const a = await sent();
  const id = Number(a.id);
  await db.execute(
    sql`UPDATE telegram_alerts SET sent_at=now()-interval '4 hours' WHERE id=${id}`,
  );
  await db.execute(sql`DELETE FROM alert_observations`);
  const start = Date.now() - 4 * 3600000;
  for (const [i, price] of [100, 120, 90].entries()) {
    const snap = (await snapshotFor(
      db,
      mint,
      {},
      { ...market, priceUsd: price },
    ))!;
    await recordObservation(
      db,
      id,
      `path:${i}`,
      new Date(start + (i + 1) * 3600000),
      "hourly",
      snap,
    );
  }
  const context = (await snapshotFor(db, mint, { ai: "new evidence" }, null))!;
  await recordObservation(
    db,
    id,
    "ai:later",
    new Date(),
    "ai_verdict",
    context,
  );
  const stats = await performance(db, id);
  expect(stats).toMatchObject({ observations: 4, priced_observations: 3 });
  expect(Number(stats.minimum_sampled_return_pct)).toBeCloseTo(-10);
  expect(Number(stats.maximum_sampled_return_pct)).toBeCloseTo(20);
  expect(Number(stats.maximum_sampled_drawdown_pct)).toBeCloseTo(-25);
  expect(Number(stats.latest_sampled_return_pct)).toBeCloseTo(-10);
  const hours = await hourlyPerformance(db, id);
  expect(hours.length).toBeGreaterThan(1);
});
it("tracks market-cap basis without switching to a later price", async () => {
  await seed();
  await captureObservation(
    db,
    mint,
    "start",
    new Date(),
    "t0",
    {},
    { ...market, priceUsd: null, mcapUsd: 1000 },
  );
  const a = await claimDelivery(db);
  expect(a!.basis).toBe("mcap");
  await markDelivery(db, Number(a!.id), "sent", 1, null);
  const snap = (await snapshotFor(
    db,
    mint,
    {},
    { ...market, priceUsd: 999, mcapUsd: 800 },
  ))!;
  await recordObservation(
    db,
    Number(a!.id),
    "follow",
    new Date(),
    "gain_refresh",
    snap,
  );
  const stats = await performance(db, Number(a!.id));
  expect(Number(stats.latest_sampled_return_pct)).toBeCloseTo(-20);
});
it("leases hourly work and continues observing archived tokens without re-alerting", async () => {
  await sent();
  await db.execute(
    sql`UPDATE tokens SET status='archived',confidence=10 WHERE mint=${mint}`,
  );
  await db.execute(
    sql`UPDATE telegram_alerts SET next_snapshot_at=now()-interval '2 hours',sent_at=now()-interval '3 hours'`,
  );
  const claims = await Promise.all([claimHourly(db), claimHourly(db)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  await db.execute(sql`UPDATE telegram_alerts SET snapshot_lease_until=NULL`);
  const load = vi.fn().mockResolvedValue({ ...market, priceUsd: 50 });
  expect(await runAlertWorker(db, { load })).toMatchObject({
    observed: 1,
    sent: 0,
  });
  expect(load).toHaveBeenCalledTimes(1);
  const hourly = asRows<Record<string, unknown>>(
    await db.execute(
      sql`SELECT * FROM alert_observations WHERE stage='hourly'`,
    ),
  );
  expect(hourly).toHaveLength(1);
  expect(hourly[0].target_at).not.toBeNull();
  expect(hourly[0].price_usd).toBe(50);
  expect((await alerts())[0].status).toBe("sent");
  expect(await claimHourly(db)).toBeNull();
});
it("preserves hourly failure evidence without fabricating a quote or filling missed hours", async () => {
  await sent();
  await db.execute(
    sql`UPDATE telegram_alerts SET next_snapshot_at=now()-interval '1 hour'`,
  );
  const load = vi.fn().mockRejectedValue(new Error("provider unavailable"));
  expect(await runAlertWorker(db, { load })).toMatchObject({
    observed: 0,
    failed: 1,
  });
  const observations = asRows<Record<string, unknown>>(
    await db.execute(
      sql`SELECT * FROM alert_observations WHERE stage='hourly_unavailable'`,
    ),
  );
  expect(observations).toHaveLength(1);
  expect(observations[0].price_usd).toBeNull();
  expect(observations[0].mcap_usd).toBeNull();
  expect(await claimHourly(db)).toBeNull();
});
it("bounds message size and does not let token metadata inject message lines", async () => {
  const a = await sent();
  a.snapshot.token.symbol = "FAKE\nConfidence 100";
  a.snapshot.token.confidence_reasons = Array(30).fill("a".repeat(200));
  const message = alertMessage(a);
  expect(message).not.toContain("\nConfidence 100");
  expect(message.length).toBeLessThanOrEqual(4096);
});

it("retains newly collected raw and parsed transactions after an alert", async () => {
  await sent();
  const event: import("@/lib/logic/parse").NormalizedEvent = {
    signature: "post-alert-tx",
    slot: 1,
    blockTime: new Date(),
    err: false,
    programs: [],
    source: "test",
    wallet: "test-wallet",
    mint,
    side: "buy",
    solDelta: -1,
    tokenDelta: 10,
    decimals: 6,
    venue: { venue: "pump.fun", graduated: false },
    raw: { onChainPayload: "retained" },
  };
  expect(await insertRawEvent(db, event)).toBe(true);
  expect(await insertRawEvent(db, event)).toBe(false);
  await updateRawFromRpc(db, { ...event, raw: { parsedPayload: "retained" } });
  await updateRawFromRpc(db, { ...event, raw: { parsedPayload: "retained" } });
  const rows = asRows<{
    stage: string;
    snapshot: { event: { rawJson: unknown } };
    price_usd: number | null;
  }>(
    await db.execute(
      sql`SELECT * FROM alert_observations WHERE stage IN ('raw_event','parsed_transaction') ORDER BY id`,
    ),
  );
  expect(rows).toHaveLength(2);
  expect(rows[0].snapshot.event.rawJson).toEqual({
    onChainPayload: "retained",
  });
  expect(rows[1].snapshot.event.rawJson).toEqual({ parsedPayload: "retained" });
  expect(rows.every((r) => r.price_usd === null)).toBe(true);
});
it("retains an AI-only update without inventing a market price", async () => {
  await sent();
  const { insertAiVerdict } = await import("@/lib/db/verdicts");
  await insertAiVerdict(db, {
    mint,
    createdAt: new Date(),
    verdict: "ok",
    conviction: 40,
    bullPoints: ["new thesis"],
    redFlags: [],
    narrative: null,
    invalidation: null,
    holderSummary: null,
    reasoning: "new evidence",
    unavailableReason: null,
    model: "test",
    inputsHash: "unique",
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    stage: "t15",
    priceUsd: 100,
    mcapUsd: 1000,
    thesisFingerprint: null,
    thesisNewestAt: null,
    theses: [],
    trigger: "material_change",
    countsTowardCap: true,
  });
  const rows = asRows<{
    snapshot: { ai: { reasoning: string } };
    price_usd: number | null;
  }>(
    await db.execute(
      sql`SELECT * FROM alert_observations WHERE stage='ai_verdict'`,
    ),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].snapshot.ai.reasoning).toBe("new evidence");
  expect(rows[0].price_usd).toBeNull();
});
it("protects every alert endpoint before accessing the database or Telegram", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
  const list = await import("@/app/api/alerts/route");
  const stats = await import("@/app/api/alerts/stats/route");
  const worker = await import("@/app/api/cron/alerts/route");
  const detail = await import("@/app/api/alerts/[id]/route");
  const req = new Request("http://localhost/api/alerts");
  for (const handler of [list.GET, stats.GET, worker.GET])
    expect((await handler(req)).status).toBe(401);
  expect(
    (await detail.GET(req, { params: Promise.resolve({ id: "1" }) })).status,
  ).toBe(401);
  vi.stubEnv("TELEGRAM_ALERTS_ENABLED", "0");
  const auth = new Request("http://localhost/api/alerts", {
    headers: { authorization: "Bearer test-only-cron-secret" },
  });
  for (const handler of [list.GET, stats.GET, worker.GET])
    expect(await (await handler(auth)).json()).toMatchObject({
      enabled: false,
    });
});

it("formats the requested compact token card and preserves unavailable values", async () => {
  await seed(77);
  await check();
  const [a] = await alerts();
  a.snapshot.token.symbol = "FAHHHH";
  a.snapshot.market = { ...market, priceUsd: 0.0000512, mcapUsd: 50800, liqUsd: 26300 };
  expect(alertMessage(a)).toBe([
    "🔔 FAHHHH", "🎯 77/100", "", "💵 $0.0000512", "🏦 MC $50.8k", "💧 Liq $26.3k", "",
    "🔗 https://gmgn.ai/sol/token/test-mint",
  ].join("\n"));
  a.snapshot.market.priceUsd = null;
  expect(alertMessage(a)).toContain("💵 —");
  a.snapshot.token.symbol = "TOKEN\nFake alert";
  expect(alertMessage(a).split("\n")[0]).toBe("🔔 TOKEN Fake alert");
});
it("recovers a stale queued alert with fresh evidence before delivery",async()=>{
  await seed();await check();credentials();
  await db.execute(sql`UPDATE telegram_alerts SET snapshot_at=now()-interval '10 minutes'`);
  const marketModule=await import('@/lib/market');
  const load=vi.spyOn(marketModule,'getDexSnapshots').mockResolvedValue(new Map([[mint,{...market,observedAt:new Date().toISOString()}]]));
  try {
    const fetcher=vi.fn().mockResolvedValue(ok());
    const result=await runAlertWorker(db,{fetcher});
    expect(result).toMatchObject({initialSent:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await alerts())[0].status).toBe('sent');
    expect(asRows(await db.execute(sql`SELECT id FROM token_checks WHERE stage='delivery_refresh'`))).toHaveLength(1);
  }finally{load.mockRestore();}
});
it("does not relabel a cached old quote as a fresh post-alert observation",async()=>{
  const a=await sent();const old=new Date(Date.now()-600000);
  const snapshot=(await snapshotFor(db,mint,{}, {...market,priceUsd:200,observedAt:old.toISOString()}))!;
  await recordObservation(db,Number(a.id),'old-cache',new Date(),'gain_refresh',snapshot);
  const result=await performance(db,Number(a.id));
  expect(result.priced_observations).toBe(0);
  const rows=asRows<{observed_at:Date|string}>(await db.execute(sql`SELECT observed_at FROM alert_observations WHERE event_key='old-cache'`));
  expect(new Date(rows[0].observed_at).getTime()).toBe(old.getTime());
});
