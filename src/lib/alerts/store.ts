import { DELIVERY_GATE } from "./delivery-gate";
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asDate, asNumber, asRows } from "@/lib/db/rows";

type AlertDb = Pick<AppDb, "execute">;

export const ALERT_CONFIDENCE = 75;
export const ALERT_QUOTE_MAX_AGE_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;
export const alertsEnabled = () => process.env.TELEGRAM_ALERTS_ENABLED === "1";
export type AlertSnapshot = {
  token: Record<string, unknown>;
  ai: Record<string, unknown> | null;
  event: unknown;
  market: Record<string, unknown> | null;
};
export type AlertRecord = {
  id: number;
  attempts: number;
  telegram_message_id?: number | null;
  mint: string;
  qualified_at: Date | string;
  snapshot_at: Date | string;
  confidence: number;
  stage: string;
  snapshot: AlertSnapshot;
  basis: "price" | "mcap";
  entry_value: number;
  status: string;
  sent_at: Date | string | null;
  next_snapshot_at: Date | string | null;
  target_at?: Date | string | null;
};
export function positiveNumber(value: unknown): number | null {
  const n = asNumber(value);
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}
function quoteNumber(value: unknown): number | null {
  const n = asNumber(value);
  return n != null && Number.isFinite(n) && n >= 0 ? n : null;
}
export async function snapshotFor(
  db: AlertDb,
  mint: string,
  event: unknown,
  market: Record<string, unknown> | null,
): Promise<AlertSnapshot | null> {
  const result = await db.execute(sql`SELECT to_jsonb(t) AS token,
    (SELECT to_jsonb(v) FROM ai_verdicts v WHERE v.mint=t.mint ORDER BY v.created_at DESC,v.id DESC LIMIT 1) AS ai
    FROM tokens t WHERE t.mint=${mint}`);
  const row = asRows<{
    token: Record<string, unknown>;
    ai: Record<string, unknown> | null;
  }>(result)[0];
  return row ? { ...row, event, market } : null;
}
export async function recordObservation(
  db: AlertDb,
  alertId: number,
  key: string,
  at: Date,
  stage: string,
  snapshot: AlertSnapshot,
  target: Date | null = null,
) {
  // Cached quotes retain provider time, not the time a later job reuses them.
  at = asDate(snapshot.market?.observedAt) ?? at;
  // Context-only events never create a synthetic price observation.
  const price = quoteNumber(snapshot.market?.priceUsd),
    mcap = quoteNumber(snapshot.market?.mcapUsd);
  // Observation and crossed milestones commit atomically, including hourly calls outside a transaction.
  await db.execute(sql`WITH observed AS (
    INSERT INTO alert_observations(alert_id,event_key,observed_at,stage,target_at,price_usd,mcap_usd,snapshot)
    VALUES (${alertId},${key},${at},${stage},${target},${price},${mcap},${JSON.stringify(snapshot)}::jsonb)
    ON CONFLICT(alert_id,event_key) DO NOTHING RETURNING *
  ) INSERT INTO telegram_alert_milestones(alert_id,observation_id,multiple,observed_value,observed_at,elapsed_seconds,snapshot)
    SELECT a.id,o.id,levels.multiple,
      CASE WHEN a.basis='price' THEN o.price_usd ELSE o.mcap_usd END,
      o.observed_at,extract(epoch FROM o.observed_at-a.sent_at),o.snapshot
    FROM observed o JOIN telegram_alerts a ON a.id=o.alert_id
      CROSS JOIN (VALUES (2),(3),(5),(10)) AS levels(multiple)
    WHERE a.status='sent' AND o.observed_at>=a.sent_at AND o.observed_at<=now()+interval '1 second'
      AND (CASE WHEN a.basis='price' THEN o.price_usd ELSE o.mcap_usd END)/a.entry_value>=levels.multiple
    ON CONFLICT(alert_id,multiple) DO NOTHING`);
}
/** Capture every pipeline observation for alerted tokens; only >=75 active tokens enter delivery. */
export async function captureObservation(
  db: AlertDb,
  mint: string,
  key: string,
  at: Date,
  stage: string,
  event: unknown,
  market: Record<string, unknown> | null,
  target: Date | null = null,
) {
  if (!alertsEnabled()) return;
  const snapshot = await snapshotFor(db, mint, event, market);
  if (!snapshot) return;
  const token = snapshot.token;
  const confidence = asNumber(token.confidence);
  const active = token.status === "candidate" || token.status === "watching";
  const price = positiveNumber(market?.priceUsd),
    mcap = positiveNumber(market?.mcapUsd);
  const quoteAt = asDate(market?.observedAt) ?? at;
  const fresh =
    quoteAt.getTime() <= Date.now() + 1000 &&
    Date.now() - quoteAt.getTime() <= ALERT_QUOTE_MAX_AGE_MS;
  const eligible =
    active &&
    confidence != null &&
    confidence >= ALERT_CONFIDENCE &&
    fresh &&
    (price != null || mcap != null);
  if (eligible) {
    await db.execute(sql`INSERT INTO telegram_alerts(mint,qualified_at,snapshot_at,confidence,stage,snapshot,basis,entry_value)
      VALUES (${mint},${at},${quoteAt},${confidence},${stage},${JSON.stringify(snapshot)}::jsonb,${price != null ? "price" : "mcap"},${price ?? mcap!})
      ON CONFLICT(mint) DO UPDATE SET snapshot_at=EXCLUDED.snapshot_at,confidence=EXCLUDED.confidence,
        stage=EXCLUDED.stage,snapshot=EXCLUDED.snapshot,basis=EXCLUDED.basis,entry_value=EXCLUDED.entry_value,status='pending'
      WHERE telegram_alerts.status IN ('pending','waiting') AND telegram_alerts.snapshot_at<=EXCLUDED.snapshot_at`);
  } else if (!active || confidence == null || confidence < ALERT_CONFIDENCE) {
    await db.execute(
      sql`UPDATE telegram_alerts SET status='waiting' WHERE mint=${mint} AND status='pending'`,
    );
  }
  const rows = asRows<{ id: number }>(
    await db.execute(sql`SELECT id FROM telegram_alerts WHERE mint=${mint}`),
  );
  if (rows[0])
    await recordObservation(db, Number(rows[0].id), key, at, stage, snapshot, target);
}
export async function recordCheckAlert(
  db: AlertDb,
  check: {
    id: number;
    mint: string;
    stage: string;
    checkedAt: Date;
    payload: unknown;
    flags: unknown;
    passed: boolean | null;
  },
) {
  if (!alertsEnabled()) return;
  const payload = check.payload as Record<string, unknown> | null;
  const raw = payload?.snap ?? payload;
  const market =
    raw && typeof raw === "object" && ("priceUsd" in raw || "mcapUsd" in raw)
      ? (raw as Record<string, unknown>)
      : null;
  await captureObservation(
    db,
    check.mint,
    `check:${check.id}`,
    check.checkedAt,
    check.stage,
    check,
    market,
    asDate(payload?.targetAt),
  );
}
export async function claimDelivery(db: AlertDb): Promise<AlertRecord | null> {
  const result = await db.execute(sql`WITH candidate AS (
    SELECT a.id,to_jsonb(t) AS token,
      (SELECT to_jsonb(v) FROM ai_verdicts v WHERE v.mint=a.mint ORDER BY v.created_at DESC,v.id DESC LIMIT 1) AS ai
    FROM telegram_alerts a JOIN tokens t ON t.mint=a.mint
    WHERE a.status='pending' AND a.next_attempt_at<=now() AND ${DELIVERY_GATE}
      AND a.snapshot_at>=now()-interval '5 minutes' AND a.snapshot_at<=now()
      AND t.status IN ('watching','candidate') AND t.confidence>=75
    ORDER BY a.qualified_at,a.id FOR UPDATE OF a SKIP LOCKED LIMIT 1
  ) UPDATE telegram_alerts a SET status='sending',attempted_at=now(),attempts=attempts+1,
      snapshot=jsonb_set(jsonb_set(a.snapshot,'{token}',candidate.token),'{ai}',coalesce(candidate.ai,'null'::jsonb)),
      confidence=(candidate.token->>'confidence')::int
    FROM candidate WHERE a.id=candidate.id RETURNING a.*`);
  return asRows<AlertRecord>(result)[0] ?? null;
}
export async function markDelivery(
  db: AlertDb,
  id: number,
  state: "sent" | "pending" | "unknown" | "failed",
  messageId: number | null,
  reason: string | null,
  retrySeconds = 0,
) {
  await db.execute(sql`UPDATE telegram_alerts SET status=${state},telegram_message_id=${messageId},delivery_error=${reason},
    sent_at=CASE WHEN ${state}='sent' THEN now() ELSE sent_at END,
    next_snapshot_at=CASE WHEN ${state}='sent' THEN now()+interval '1 hour' ELSE next_snapshot_at END,
    next_attempt_at=now()+${Math.max(0, retrySeconds)}*interval '1 second'
    WHERE id=${id} AND status='sending'`);
}
export async function listAlerts(
  db: AlertDb,
  before: number | null,
  limit = 50,
) {
  return asRows<AlertRecord>(
    await db.execute(sql`SELECT id,mint,qualified_at,snapshot_at,confidence,stage,snapshot,basis,entry_value,status,sent_at,telegram_message_id
    FROM telegram_alerts WHERE status='sent' AND (${before}::bigint IS NULL OR id<${before}) ORDER BY id DESC LIMIT ${limit}`),
  );
}
export async function alertById(db: AlertDb, id: number) {
  return (
    asRows<AlertRecord>(
      await db.execute(
        sql`SELECT * FROM telegram_alerts WHERE id=${id} AND status='sent'`,
      ),
    )[0] ?? null
  );
}
export async function alertObservations(
  db: AlertDb,
  id: number,
  after: number,
  limit: number,
) {
  return asRows<{ id: number; [key: string]: unknown }>(
    await db.execute(
      sql`SELECT * FROM alert_observations WHERE alert_id=${id} AND id>${after} ORDER BY id LIMIT ${limit}`,
    ),
  );
}
export async function claimHourly(db: AlertDb): Promise<AlertRecord | null> {
  return (await claimHourlyBatch(db,1))[0] ?? null;
}
export async function claimHourlyBatch(db: AlertDb, limit = 30): Promise<AlertRecord[]> {
  return asRows<AlertRecord>(await db.execute(sql`WITH due AS (
    SELECT id,next_snapshot_at FROM telegram_alerts WHERE status='sent' AND next_snapshot_at<=now()
      AND (snapshot_lease_until IS NULL OR snapshot_lease_until<=now())
    ORDER BY next_snapshot_at,id FOR UPDATE SKIP LOCKED LIMIT ${Math.min(30,Math.max(1,limit))}
  ) UPDATE telegram_alerts a SET snapshot_lease_until=now()+interval '5 minutes'
    FROM due WHERE a.id=due.id RETURNING a.*, due.next_snapshot_at AS target_at`));
}
export async function finishHourly(db: AlertDb, alert: AlertRecord, at: Date) {
  const sent = asDate(alert.sent_at)!;
  const next = new Date(
    sent.getTime() +
      (Math.floor((at.getTime() - sent.getTime()) / HOUR_MS) + 1) * HOUR_MS,
  );
  await db.execute(
    sql`UPDATE telegram_alerts SET next_snapshot_at=${next},snapshot_lease_until=NULL WHERE id=${alert.id}`,
  );
}
