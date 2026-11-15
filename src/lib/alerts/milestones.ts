import { DELIVERY_GATE } from "./delivery-gate";
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { asRows } from "@/lib/db/rows";
import type { AlertSnapshot } from "./store";
export const GAIN_MILESTONES = [2, 3, 5, 10] as const;
export type MilestoneRecord = {
  id: number;
  alert_id: number;
  observation_id: number;
  multiple: number;
  observed_value: number;
  observed_at: Date | string;
  elapsed_seconds: number;
  snapshot: AlertSnapshot;
  status: string;
  mint: string;
  entry_value: number;
  basis: "price" | "mcap";
};
export async function claimMilestone(
  db: AppDb,
): Promise<MilestoneRecord | null> {
  const rows = asRows<MilestoneRecord>(
    await db.execute(sql`WITH candidate AS (
    SELECT m.id,a.mint,a.entry_value,a.basis FROM telegram_alert_milestones m
      JOIN telegram_alerts a ON a.id=m.alert_id
    WHERE m.status='pending' AND m.next_attempt_at<=now() AND ${DELIVERY_GATE} AND a.status='sent'
    ORDER BY m.observed_at,m.multiple,m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1
  ) UPDATE telegram_alert_milestones m SET status='sending',attempted_at=now(),attempts=attempts+1
    FROM candidate WHERE m.id=candidate.id
    RETURNING m.*,candidate.mint,candidate.entry_value,candidate.basis`),
  );
  return rows[0] ?? null;
}
export async function markMilestone(
  db: AppDb,
  id: number,
  state: "sent" | "pending" | "unknown" | "failed",
  messageId: number | null,
  reason: string | null,
  retrySeconds = 0,
) {
  await db.execute(sql`UPDATE telegram_alert_milestones SET status=${state},telegram_message_id=${messageId},delivery_error=${reason},
    sent_at=CASE WHEN ${state}='sent' THEN now() ELSE sent_at END,
    next_attempt_at=now()+${Math.max(0, retrySeconds)}*interval '1 second'
    WHERE id=${id} AND status='sending'`);
}
export async function listMilestones(db: AppDb, alertId: number) {
  return asRows<Record<string, unknown>>(
    await db.execute(
      sql`SELECT * FROM telegram_alert_milestones WHERE alert_id=${alertId} ORDER BY multiple`,
    ),
  );
}
export async function milestoneStats(db: AppDb) {
  return asRows<Record<string, unknown>>(
    await db.execute(sql`WITH cohort AS (
    SELECT count(*)::int AS sent_alerts FROM telegram_alerts WHERE status='sent'
  ) SELECT levels.multiple,cohort.sent_alerts AS total_sent_alerts,count(m.id)::int AS alerts_observed_reaching,
    (count(m.id) FILTER(WHERE m.status='sent'))::int AS telegram_notifications_sent,
    (count(m.id) FILTER(WHERE m.status='pending'))::int AS notifications_pending,
    (count(m.id) FILTER(WHERE m.status='sending'))::int AS notifications_sending,
    (count(m.id) FILTER(WHERE m.status='unknown'))::int AS notifications_unknown,
    (count(m.id) FILTER(WHERE m.status='failed'))::int AS notifications_failed,
    (count(m.id) FILTER(WHERE m.status='sending' AND m.attempted_at<now()-interval '2 minutes'))::int AS stalled_needing_reconciliation,
    100.0*count(m.id)/nullif(cohort.sent_alerts,0) AS observed_reach_pct_of_sent_alerts,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY m.elapsed_seconds) AS median_seconds_to_first_observed_reach
    FROM (VALUES (2),(3),(5),(10)) levels(multiple) CROSS JOIN cohort
    LEFT JOIN telegram_alert_milestones m ON m.multiple=levels.multiple
    GROUP BY levels.multiple,cohort.sent_alerts ORDER BY levels.multiple`),
  );
}
