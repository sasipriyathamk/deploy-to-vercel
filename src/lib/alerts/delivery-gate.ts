import { sql } from "drizzle-orm";

// One configured chat: an explicit retry-after pauses both notification kinds.
export const DELIVERY_GATE = sql`NOT EXISTS (
  SELECT 1 FROM telegram_alerts gate WHERE gate.status='pending'
    AND gate.delivery_error='Telegram explicitly rejected request: rate limit' AND gate.next_attempt_at>now()
) AND NOT EXISTS (
  SELECT 1 FROM telegram_alert_milestones gate WHERE gate.status='pending'
    AND gate.delivery_error='Telegram explicitly rejected request: rate limit' AND gate.next_attempt_at>now()
)`;
