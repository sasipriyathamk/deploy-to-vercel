import { insertCheck } from "@/lib/db/repo";
import { applyRefresh } from "@/lib/pipeline";
import { sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { emptySnapshot, getDexSnapshots } from "@/lib/market";
import { deliverNotifications } from "./telegram";
import {
  positiveNumber,
  alertsEnabled,
  claimHourlyBatch,
  finishHourly,
} from "./store";
import { asRows, asDate } from "@/lib/db/rows";

async function executeAlertWorker(
  db: AppDb,
  options?: {
    deadline?: number;
    load?: (
      db: AppDb,
      mint: string,
    ) => Promise<import("@/lib/logic/funnel").MarketSnapshot>;
    fetcher?: typeof fetch;
  },
) {
  if (!alertsEnabled()) return { enabled: false, sent: 0, observed: 0 };
  const deadline = options?.deadline ?? Date.now() + 45000;
  // Revalidate stale queued opportunities in a bounded provider batch. Never send an old baseline.
  await db.execute(sql`UPDATE telegram_alerts a SET status='waiting' FROM tokens t
    WHERE a.mint=t.mint AND a.status='pending' AND (t.status NOT IN ('watching','candidate') OR t.confidence IS NULL OR t.confidence<75)`);
  const stale = asRows<{mint:string}>(await db.execute(sql`SELECT a.mint FROM telegram_alerts a JOIN tokens t USING(mint)
    WHERE a.status IN ('pending','waiting') AND a.snapshot_at<now()-interval '5 minutes'
    AND a.next_attempt_at<=now() AND t.status IN ('watching','candidate') AND t.confidence>=75
    ORDER BY a.snapshot_at,a.id LIMIT 30`));
  if (stale.length && Date.now()+20000<deadline) {
    try {
      const quotes = await getDexSnapshots(db,stale.map(row=>row.mint));
      for (const {mint} of stale) {
        if (Date.now()+10000>=deadline) break;
        const market = quotes.get(mint);
        if (market && (positiveNumber(market.priceUsd)!=null || positiveNumber(market.mcapUsd)!=null)) await applyRefresh(db,mint,market,"delivery_refresh");
        else await insertCheck(db,{mint,stage:"delivery_refresh_unavailable",passed:false,flags:{missingQuote:true},payload:{snap:emptySnapshot("unavailable")}});
      }
    } catch {
      // Keep durable queued evidence for another scheduled attempt; never fabricate fresh data.
    }
  }
  const delivery = await deliverNotifications(db, {
    deadline: Math.min(deadline-18000,Date.now()+35000),
    limit: 30,
    fetcher: options?.fetcher,
  });
  let observed = 0,
    failed = 0;
  const due = Date.now()+12000<deadline ? await claimHourlyBatch(db,30) : [];
  let hourlyQuotes: Map<string,import("@/lib/logic/funnel").MarketSnapshot> | null = null;
  if (due.length && !options?.load) {
    try {
      const latestTarget = new Date(Math.max(...due.map(alert=>asDate(alert.target_at)?.getTime() ?? 0)));
      hourlyQuotes=await getDexSnapshots(db,due.map(alert=>alert.mint),{freshAfter:latestTarget});
    } catch { hourlyQuotes=new Map(); }
  }
  for (const alert of due) {
    if (Date.now()+1000>=deadline) {
      await db.execute(sql`UPDATE telegram_alerts SET snapshot_lease_until=NULL WHERE id=${alert.id}`);
      continue;
    }
    let at = new Date();
    try {
      const market = options?.load
        ? await options.load(db, alert.mint)
        : hourlyQuotes?.get(alert.mint);
      if (
        !market ||
        (positiveNumber(market.priceUsd) == null &&
          positiveNumber(market.mcapUsd) == null)
      )
        throw new Error("No usable quote");
      at = new Date();
      await applyRefresh(db,alert.mint,market,"hourly",asDate(alert.target_at));
      await finishHourly(db, alert, at);
      observed++;
    } catch {
      await insertCheck(db,{mint:alert.mint,stage:"hourly_unavailable",passed:false,checkedAt:at,
        flags:{missingQuote:true},payload:{snap:emptySnapshot("unavailable"),targetAt:alert.target_at,error:"Market observation unavailable"}});
      // Lease expires after five minutes; retry the same due observation, never invent a missed quote.
      failed++;
    }
  }
  // Hourly samples may have just crossed a milestone; deliver within the remaining budget.
  const followup = !delivery.paused
    ? await deliverNotifications(db, {
        deadline,
        limit: Math.max(0, 30 - delivery.attempted),
        fetcher: options?.fetcher,
      })
    : {
        attempted: 0,
        sent: 0,
        initialSent: 0,
        milestonesSent: 0,
        paused: true,
      };
  return {
    enabled: true,
    attempted: delivery.attempted + followup.attempted,
    sent: delivery.sent + followup.sent,
    initialSent: delivery.initialSent + followup.initialSent,
    milestonesSent: delivery.milestonesSent + followup.milestonesSent,
    observed,
    failed,
  };
}

export async function runAlertWorker(
  db: AppDb,
  options?: Parameters<typeof executeAlertWorker>[1],
) {
  if (!alertsEnabled()) return { enabled: false, sent: 0, observed: 0 };
  await db.execute(sql`INSERT INTO pipeline_runs(route,started_at,finished_at) VALUES ('alerts',now(),NULL)
    ON CONFLICT(route) DO UPDATE SET started_at=now(),finished_at=NULL`);
  try {
    return await executeAlertWorker(db, options);
  } finally {
    await db.execute(
      sql`UPDATE pipeline_runs SET finished_at=now() WHERE route='alerts'`,
    );
  }
}
