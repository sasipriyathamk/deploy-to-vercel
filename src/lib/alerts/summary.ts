import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows, asNumber, asDate } from "@/lib/db/rows";
import { alertSystemStats, recentAlertPerformance } from "./stats";

export type AlertSummary = {
  configuration: {
    enabled: boolean;
    botConfigured: boolean;
    chatConfigured: boolean;
    workerSecretConfigured: boolean;
    schemaReady: boolean;
  };
  qualifyingTokens: number;
  delivery: Record<string, number> | null;
  performance: {
    covered: number;
    unobserved: number;
    aboveBaseline: number;
    meanReturn: number | null;
    worstDrawdown: number | null;
  } | null;
  milestones: {
    multiple: number;
    reached: number;
    sent: number;
    pending: number;
    review: number;
    medianSeconds: number | null;
  }[];
  queuedStale: number | null;
  queuedFresh: number | null;
  hourlyDue: number | null;
  stalledSending: number | null;
  lastWorkerAt: string | null;
  lastWorkerFinishedAt: string | null;
  lastSentAt: string | null;
  recent: {
    id: number;
    mint: string;
    symbol: string;
    confidence: number;
    sentAt: string;
    basis: string;
    latestReturn: number | null;
    drawdown: number | null;
    pricedObservations: number;
    milestones: number[];
  }[];
};
const number = (v: unknown) => asNumber(v) ?? 0;
const iso = (v: unknown) => asDate(v)?.toISOString() ?? null;
/** UI projection only: no credentials, chat IDs, full evidence payloads or error details. */
export async function alertSummary(db: AppDb): Promise<AlertSummary> {
  const [schema] = asRows<{ ready: boolean }>(
    await db.execute(sql`SELECT
    to_regclass('public.telegram_alerts') IS NOT NULL AND to_regclass('public.alert_observations') IS NOT NULL
    AND to_regclass('public.telegram_alert_milestones') IS NOT NULL AS ready`),
  );
  const [cohort] = asRows<{ n: number }>(
    await db.execute(
      sql`SELECT count(*)::int AS n FROM tokens WHERE status IN ('watching','candidate') AND confidence>=75`,
    ),
  );
  const [worker] = asRows<{ started_at: unknown; finished_at: unknown }>(
    await db.execute(
      sql`SELECT started_at,finished_at FROM pipeline_runs WHERE route='alerts'`,
    ),
  );
  const config = {
    enabled: process.env.TELEGRAM_ALERTS_ENABLED === "1",
    botConfigured: !!process.env.TELEGRAM_BOT_TOKEN?.trim(),
    chatConfigured: !!process.env.TELEGRAM_CHAT_ID?.trim(),
    workerSecretConfigured: !!process.env.CRON_SECRET?.trim(),
    schemaReady: schema.ready,
  };
  const base: AlertSummary = {
    configuration: config,
    qualifyingTokens: number(cohort?.n),
    delivery: null,
    performance: null,
    milestones: [],
    queuedStale: null,
    queuedFresh: null,
    hourlyDue: null,
    stalledSending: null,
    lastWorkerAt: iso(worker?.started_at),
    lastWorkerFinishedAt: iso(worker?.finished_at),
    lastSentAt: null,
    recent: [],
  };
  if (!schema.ready) return base;
  const [raw, recent, last] = await Promise.all([
    alertSystemStats(db),
    recentAlertPerformance(db),
    db.execute(
      sql`SELECT max(sent_at) AS at FROM telegram_alerts WHERE status='sent'`,
    ),
  ]);
  const delivery: Record<string, number> = {
    sent: 0,
    pending: 0,
    waiting: 0,
    sending: 0,
    failed: 0,
    unknown: 0,
  };
  for (const row of raw.delivery as { status: string; count: number }[])
    delivery[row.status] = number(row.count);
  const p = raw.outcomes as Record<string, unknown>,
    m = raw.monitoring as Record<string, unknown>;
  return {
    ...base,
    delivery,
    lastSentAt: iso(asRows<{ at: unknown }>(last)[0]?.at),
    performance: {
      covered: number(p.alerts_with_priced_followup),
      unobserved: number(p.alerts_without_priced_followup),
      aboveBaseline: number(p.alerts_currently_above_baseline),
      meanReturn: asNumber(p.mean_latest_sampled_return_pct),
      worstDrawdown: asNumber(p.worst_sampled_drawdown_pct),
    },
    queuedStale: number(m.queued_stale),
    queuedFresh: number(m.queued_fresh),
    hourlyDue: number(m.hourly_due),
    stalledSending: number(m.stalled_delivery_needs_reconciliation),
    milestones: raw.milestones.map((row) => ({
      multiple: number(row.multiple),
      reached: number(row.alerts_observed_reaching),
      sent: number(row.telegram_notifications_sent),
      pending:
        number(row.notifications_pending) + number(row.notifications_sending),
      review:
        number(row.notifications_unknown) +
        number(row.notifications_failed) +
        number(row.stalled_needing_reconciliation),
      medianSeconds: asNumber(row.median_seconds_to_first_observed_reach),
    })),
    recent: recent.map((r) => ({
      id: number(r.id),
      mint: String(r.mint),
      symbol: String(r.symbol ?? r.mint),
      confidence: number(r.confidence),
      sentAt: iso(r.sent_at)!,
      basis: String(r.basis),
      latestReturn: asNumber(r.latest_return),
      drawdown: asNumber(r.maximum_drawdown),
      pricedObservations: number(r.priced_observations),
      milestones: Array.isArray(r.milestones) ? r.milestones.map(number) : [],
    })),
  };
}
