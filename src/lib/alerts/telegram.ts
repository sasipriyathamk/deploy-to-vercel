import {
  claimMilestone,
  markMilestone,
  type MilestoneRecord,
} from "./milestones";
import type { AppDb } from "@/lib/db/index";
import { compactUsd, fmtTime } from "@/lib/format";
import {
  alertsEnabled,
  claimDelivery,
  markDelivery,
  type AlertRecord,
} from "./store";

function text(value: unknown, length = 120): string {
  return String(value ?? "Unknown")
    .replace(/[\r\n\x00-\x1f]/g, " ")
    .slice(0, length);
}
/** Telegram stays compact; the complete snapshot remains in the durable ledger. */
function messageUsd(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return compactUsd(value).replace(/(\.\d*?)0+([kMB])$/, "$1$2").replace(/\.([kMB])$/, "$1");
}
function marketLines(market: AlertRecord["snapshot"]["market"]): string[] {
  return [
    `💵 ${messageUsd(market?.priceUsd)}`,
    `🏦 MC ${messageUsd(market?.mcapUsd)}`,
    `💧 Liq ${messageUsd(market?.liqUsd)}`,
  ];
}
function gmgnLink(mint: string): string {
  return `🔗 https://gmgn.ai/sol/token/${encodeURIComponent(mint)}`;
}
export function alertMessage(alert: AlertRecord): string {
  const t = alert.snapshot.token;
  return [
    `🔔 ${text(t.symbol ?? t.name ?? alert.mint, 60)}`,
    `🎯 ${alert.confidence}/100`,
    "",
    ...marketLines(alert.snapshot.market),
    "",
    gmgnLink(alert.mint),
  ].join("\n");
}
export async function deliverPendingAlerts(
  db: AppDb,
  options?: { deadline?: number; limit?: number; fetcher?: typeof fetch },
) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim(),
    chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!alertsEnabled() || !token || !chat) return { attempted: 0, sent: 0 };
  const deadline = options?.deadline ?? Date.now() + 10000;
  let attempted = 0,
    sent = 0;
  while (attempted < (options?.limit ?? 1) && Date.now() + 9000 < deadline) {
    const alert = await claimDelivery(db);
    if (!alert) break;
    attempted++;
    const outcome = await sendTelegram(
      alertMessage(alert),
      options?.fetcher ?? fetch,
    );
    await markDelivery(
      db,
      Number(alert.id),
      outcome.state,
      outcome.messageId,
      outcome.reason,
      outcome.retrySeconds,
    );
    if (outcome.state === "sent") sent++;
    else return { attempted, sent, paused: true };
  }
  return { attempted, sent };
}
/** Never turn a Telegram outage into a failed discovery job; the durable ledger retains its state. */
export async function flushAlerts(db: AppDb, deadline: number) {
  if (!alertsEnabled()) return;
  try {
    await deliverNotifications(db, { deadline, limit: 10 });
  } catch {
    console.warn(
      "[keel] Telegram delivery ledger needs reconciliation; no automatic ambiguous retries",
    );
  }
}

type DeliveryOutcome = {
  state: "sent" | "pending" | "unknown" | "failed";
  messageId: number | null;
  reason: string | null;
  retrySeconds?: number;
};
function configured() {
  return (
    alertsEnabled() &&
    !!process.env.TELEGRAM_BOT_TOKEN?.trim() &&
    !!process.env.TELEGRAM_CHAT_ID?.trim()
  );
}
async function sendTelegram(
  message: string,
  fetcher: typeof fetch,
): Promise<DeliveryOutcome> {
  let response: Response,
    body: {
      ok?: boolean;
      result?: { message_id?: number };
      parameters?: { retry_after?: number };
    };
  try {
    response = await fetcher(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!.trim()}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID!.trim(),
          text: message,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    const parsed = await response.json();
    body = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {
      state: "unknown",
      messageId: null,
      reason:
        "Transport or response was ambiguous; do not automatically resend",
    };
  }
  if (
    response.ok &&
    body.ok === true &&
    Number.isSafeInteger(body.result?.message_id) &&
    body.result!.message_id! > 0
  )
    return { state: "sent", messageId: body.result!.message_id!, reason: null };
  if (response.status === 429 && body.ok === false) {
    const wait = Number(body.parameters?.retry_after);
    return {
      state: "pending",
      messageId: null,
      reason: "Telegram explicitly rejected request: rate limit",
      retrySeconds: Number.isFinite(wait) ? Math.max(1, Math.ceil(wait)) : 30,
    };
  }
  const rejected =
    response.status >= 400 && response.status < 500 && body.ok === false;
  return {
    state: rejected ? "failed" : "unknown",
    messageId: null,
    reason: rejected
      ? "Telegram rejected the request; check secure configuration"
      : "Delivery response was ambiguous; do not automatically resend",
  };
}
export function milestoneMessage(m: MilestoneRecord): string {
  const name = text(
    m.snapshot.token.symbol ?? m.snapshot.token.name ?? m.mint,
    60,
  );
  const observed = Number(m.observed_value) / Number(m.entry_value);
  return [
    `🚀 ${name} · ${m.multiple}× milestone`,
    `📈 Observed ${observed.toFixed(2)}× (+${((observed - 1) * 100).toFixed(1)}%)`,
    `↗️ From alert ${m.basis === "price" ? "price" : "MC"} ${messageUsd(Number(m.entry_value))}`,
    "",
    ...marketLines(m.snapshot.market),
    `⏱ ${fmtTime(m.observed_at)}`,
    "",
    gmgnLink(m.mint),
  ].join("\n");
}
export async function deliverPendingMilestones(
  db: AppDb,
  options?: { deadline?: number; limit?: number; fetcher?: typeof fetch },
) {
  if (!configured()) return { attempted: 0, sent: 0 };
  const deadline = options?.deadline ?? Date.now() + 10000;
  let attempted = 0,
    sent = 0;
  while (attempted < (options?.limit ?? 1) && Date.now() + 9000 < deadline) {
    const milestone = await claimMilestone(db);
    if (!milestone) break;
    attempted++;
    const outcome = await sendTelegram(
      milestoneMessage(milestone),
      options?.fetcher ?? fetch,
    );
    await markMilestone(
      db,
      Number(milestone.id),
      outcome.state,
      outcome.messageId,
      outcome.reason,
      outcome.retrySeconds,
    );
    if (outcome.state === "sent") sent++;
    else return { attempted, sent, paused: true };
  }
  return { attempted, sent };
}
export async function deliverNotifications(
  db: AppDb,
  options?: { deadline?: number; limit?: number; fetcher?: typeof fetch },
) {
  const limit = options?.limit ?? 3;
  const deadline = options?.deadline ?? Date.now() + 10000;
  const totals = { attempted: 0, sent: 0, initialSent: 0, milestonesSent: 0, paused: false };
  // Alternate kinds so a discovery burst cannot starve earned milestones.
  while (totals.attempted < limit && Date.now() + 9000 < deadline) {
    let attempted = 0;
    for (const kind of ["milestone", "initial"] as const) {
      if (totals.attempted >= limit || Date.now() + 9000 >= deadline) break;
      const result = await (kind === "initial" ? deliverPendingAlerts : deliverPendingMilestones)(db, { ...options, deadline, limit: 1 });
      totals.attempted += result.attempted;
      attempted += result.attempted;
      totals.sent += result.sent;
      if (kind === "initial") totals.initialSent += result.sent;
      else totals.milestonesSent += result.sent;
      if (result.paused) return { ...totals, paused: true };
      // Telegram's per-chat pacing; explicit 429 backoff still gates both kinds.
      if (result.attempted && totals.attempted < limit) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!attempted) break;
  }
  return totals;
}
