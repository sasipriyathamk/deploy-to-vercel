import { alertsEnabled, recordCheckAlert, captureObservation } from "@/lib/alerts/store";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import {
  pipelineJobs,
  providerCalls,
  rawEvents,
  tokenChecks,
  tokens,
  wallets,
} from "@/lib/db/schema";
import { asBoolean, asDate, asJson, asNumber, asRows } from "@/lib/db/rows";
import { compareCandidates, type AlertPath, type CapRegime, type PathMark } from "@/lib/logic/confidence";
import type { ScoreBreakdown } from "@/lib/logic/score";
import type { NormalizedEvent } from "@/lib/logic/parse";
import { positive } from "@/lib/logic/gains";
import { planDiscovery, isQuoteMint } from "@/lib/logic/junk";
import { blankToNull, httpsUrl } from "@/lib/logic/metadata";
import { parseSocials, type TokenSocials } from "@/lib/logic/quality";
import { JOB_PRIORITY_SQL } from "@/lib/logic/queue";
import { venueFromPrograms } from "@/lib/logic/venue";

export type TokenRecord = {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  decimals: number | null;
  firstSeenAt: Date | null;
  firstSeenPriceUsd: number | null;
  firstSeenMcapUsd: number | null;
  sniperBuyPriceUsd: number | null;
  sniperBuyMcapUsd: number | null;
  sniperBuySol: number | null;
  sniperBuyTx: string | null;
  sniperBuyAt: Date | null;
  sniperWallet: string | null;
  entryAt: Date | null;
  entryPriceUsd: number | null;
  entryMcapUsd: number | null;
  status: string;
  score: number;
  scoreBreakdown: ScoreBreakdown | null;
  lastPriceUsd: number | null;
  lastMcapUsd: number | null;
  lastLiqUsd: number | null;
  lastVolM5: number | null;
  lastVolH1: number | null;
  lastBuysM5: number | null;
  lastSellsM5: number | null;
  lastBuysH1: number | null;
  lastSellsH1: number | null;
  lastBuyersEstimate: number | null;
  lastCheckedAt: Date | null;
  gainPct: number | null;
  gainBasis: "price" | "mcap" | null;
  athPriceUsd: number | null;
  athMcapUsd: number | null;
  athGainPct: number | null;
  athAt: Date | null;
  archiveReason: string | null;
  archivedAt: Date | null;
  reviveCount: number;
  revivedAt: Date | null;
  sniperStillHolding: boolean | null;
  venue: string | null;
  graduated: boolean;
  t5VolM5: number | null;
  weakSince: Date | null;
  holdCheckedAt: Date | null;
  pairCount: number | null;
  topHolderPct: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  rugcheckNormalised: number | null;
  firstAlertAt: Date | null;
  firstAlertPriceUsd: number | null;
  firstAlertMcapUsd: number | null;
  confidence: number | null;
  confidencePending: number | null;
  confidenceReasons: string[];
  capRegime: CapRegime | null;
  alertPath: AlertPath | null;
  weakRechecks: number;
  scorePending: number | null;
  socials: TokenSocials | null;
  promotionHits: string | null;
};

type TokenRow = typeof tokens.$inferSelect;

export function mapToken(row: TokenRow | Record<string, unknown>): TokenRecord {
  const source = row as Record<string, unknown>;
  const basis = source.gainBasis ?? source.gain_basis;
  return {
    mint: String(source.mint),
    symbol: blankToNull(source.symbol as string | null),
    name: blankToNull(source.name as string | null),
    imageUrl: httpsUrl((source.imageUrl as string | null) ?? (source.image_url as string | null)),
    decimals: asNumber(source.decimals),
    firstSeenAt: asDate(source.firstSeenAt ?? source.first_seen_at),
    firstSeenPriceUsd: asNumber(source.firstSeenPriceUsd ?? source.first_seen_price_usd),
    firstSeenMcapUsd: asNumber(source.firstSeenMcapUsd ?? source.first_seen_mcap_usd),
    sniperBuyPriceUsd: asNumber(source.sniperBuyPriceUsd ?? source.sniper_buy_price_usd),
    sniperBuyMcapUsd: asNumber(source.sniperBuyMcapUsd ?? source.sniper_buy_mcap_usd),
    sniperBuySol: asNumber(source.sniperBuySol ?? source.sniper_buy_sol),
    sniperBuyTx: (source.sniperBuyTx as string | null) ?? (source.sniper_buy_tx as string | null) ?? null,
    sniperBuyAt: asDate(source.sniperBuyAt ?? source.sniper_buy_at),
    sniperWallet: (source.sniperWallet as string | null) ?? (source.sniper_wallet as string | null) ?? null,
    entryAt: asDate(source.entryAt ?? source.entry_at),
    entryPriceUsd: asNumber(source.entryPriceUsd ?? source.entry_price_usd),
    entryMcapUsd: asNumber(source.entryMcapUsd ?? source.entry_mcap_usd),
    status: String(source.status),
    score: asNumber(source.score) ?? 50,
    scoreBreakdown: asJson<ScoreBreakdown>(source.scoreBreakdown ?? source.score_breakdown),
    lastPriceUsd: asNumber(source.lastPriceUsd ?? source.last_price_usd),
    lastMcapUsd: asNumber(source.lastMcapUsd ?? source.last_mcap_usd),
    lastLiqUsd: asNumber(source.lastLiqUsd ?? source.last_liq_usd),
    lastVolM5: asNumber(source.lastVolM5 ?? source.last_vol_m5),
    lastVolH1: asNumber(source.lastVolH1 ?? source.last_vol_h1),
    lastBuysM5: asNumber(source.lastBuysM5 ?? source.last_buys_m5),
    lastSellsM5: asNumber(source.lastSellsM5 ?? source.last_sells_m5),
    lastBuysH1: asNumber(source.lastBuysH1 ?? source.last_buys_h1),
    lastSellsH1: asNumber(source.lastSellsH1 ?? source.last_sells_h1),
    lastBuyersEstimate: asNumber(source.lastBuyersEstimate ?? source.last_buyers_estimate),
    lastCheckedAt: asDate(source.lastCheckedAt ?? source.last_checked_at),
    gainPct: asNumber(source.gainPct ?? source.gain_pct),
    gainBasis: basis === "price" || basis === "mcap" ? basis : null,
    athPriceUsd: asNumber(source.athPriceUsd ?? source.ath_price_usd),
    athMcapUsd: asNumber(source.athMcapUsd ?? source.ath_mcap_usd),
    athGainPct: asNumber(source.athGainPct ?? source.ath_gain_pct),
    athAt: asDate(source.athAt ?? source.ath_at),
    archiveReason: (source.archiveReason as string | null) ?? (source.archive_reason as string | null) ?? null,
    archivedAt: asDate(source.archivedAt ?? source.archived_at),
    reviveCount: asNumber(source.reviveCount ?? source.revive_count) ?? 0,
    revivedAt: asDate(source.revivedAt ?? source.revived_at),
    sniperStillHolding: asBoolean(source.sniperStillHolding ?? source.sniper_still_holding),
    venue: (source.venue as string | null) ?? null,
    graduated: Boolean(source.graduated),
    t5VolM5: asNumber(source.t5VolM5 ?? source.t5_vol_m5),
    weakSince: asDate(source.weakSince ?? source.weak_since),
    holdCheckedAt: asDate(source.holdCheckedAt ?? source.hold_checked_at),
    pairCount: asNumber(source.pairCount ?? source.pair_count),
    topHolderPct: asNumber(source.topHolderPct ?? source.top_holder_pct),
    mintRevoked: asBoolean(source.mintRevoked ?? source.mint_revoked),
    freezeRevoked: asBoolean(source.freezeRevoked ?? source.freeze_revoked),
    rugcheckNormalised: asNumber(source.rugcheckNormalised ?? source.rugcheck_normalised),
    firstAlertAt: asDate(source.firstAlertAt ?? source.first_alert_at),
    firstAlertPriceUsd: asNumber(source.firstAlertPriceUsd ?? source.first_alert_price_usd),
    firstAlertMcapUsd: asNumber(source.firstAlertMcapUsd ?? source.first_alert_mcap_usd),
    confidence: asNumber(source.confidence),
    confidencePending: asNumber(source.confidencePending ?? source.confidence_pending),
    confidenceReasons: asStringList(source.confidenceReasons ?? source.confidence_reasons),
    capRegime: asRegime(source.capRegime ?? source.cap_regime),
    alertPath: asAlertPath(source.alertPath ?? source.alert_path),
    weakRechecks: asNumber(source.weakRechecks ?? source.weak_rechecks) ?? 0,
    scorePending: asNumber(source.scorePending ?? source.score_pending),
    socials: parseSocials(source.socials),
    promotionHits:
      ((source.promotionHits as string | null) ?? (source.promotion_hits as string | null) ?? null) || null,
  };
}

function asStringList(value: unknown): string[] {
  const parsed = asJson<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function asRegime(value: unknown): CapRegime | null {
  return value === "fresh" || value === "mid" || value === "extended" ? value : null;
}

function asAlertPath(value: unknown): AlertPath | null {
  const parsed = asJson<Record<string, unknown>>(value);
  if (!parsed || typeof parsed !== "object") return null;
  const path: AlertPath = {};
  for (const stage of ["t5", "t15", "t60"] as const) {
    const mark = parsed[stage];
    if (mark === "held" || mark === "soft" || mark === "dumped") path[stage] = mark as PathMark;
  }
  return Object.keys(path).length > 0 ? path : null;
}

export async function getToken(db: AppDb, mint: string): Promise<TokenRecord | null> {
  const rows = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);
  return rows[0] ? mapToken(rows[0]) : null;
}

export async function insertTokenIfNew(
  db: AppDb,
  values: typeof tokens.$inferInsert,
): Promise<boolean> {
  const inserted = await db.insert(tokens).values(values).onConflictDoNothing({ target: tokens.mint }).returning();
  return inserted.length > 0;
}

export type TokenPatch = Partial<{
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  decimals: number | null;
  status: string;
  score: number;
  scoreBreakdown: ScoreBreakdown | null;
  firstSeenPriceUsd: number | null;
  firstSeenMcapUsd: number | null;
  sniperBuyPriceUsd: number | null;
  sniperBuyMcapUsd: number | null;
  lastPriceUsd: number | null;
  lastMcapUsd: number | null;
  lastLiqUsd: number | null;
  lastVolM5: number | null;
  lastVolH1: number | null;
  lastBuysM5: number | null;
  lastSellsM5: number | null;
  lastBuysH1: number | null;
  lastSellsH1: number | null;
  lastBuyersEstimate: number | null;
  lastCheckedAt: Date | null;
  gainPct: number | null;
  gainBasis: string | null;
  athPriceUsd: number | null;
  athMcapUsd: number | null;
  athGainPct: number | null;
  athAt: Date | null;
  archiveReason: string | null;
  archivedAt: Date | null;
  reviveCount: number;
  revivedAt: Date | null;
  sniperStillHolding: boolean | null;
  venue: string | null;
  graduated: boolean;
  t5VolM5: number | null;
  weakSince: Date | null;
  holdCheckedAt: Date | null;
  pairCount: number | null;
  topHolderPct: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  rugcheckNormalised: number | null;
  firstAlertAt: Date | null;
  firstAlertPriceUsd: number | null;
  firstAlertMcapUsd: number | null;
  confidence: number | null;
  confidencePending: number | null;
  confidenceReasons: string[] | null;
  capRegime: CapRegime | null;
  alertPath: AlertPath | null;
  weakRechecks: number;
  scorePending: number | null;
  socials: TokenSocials | null;
  promotionHits: string | null;
}>;

export async function updateToken(db: AppDb, mint: string, patch: TokenPatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db.update(tokens).set(patch).where(eq(tokens.mint, mint));
}

/**
 * Entry columns are written only while entry_at is still null.
 * A second call is a no-op even if the prices differ.
 */
export async function stampEntryIfEmpty(
  db: AppDb,
  mint: string,
  quote: { at: Date; priceUsd: number | null; mcapUsd: number | null },
): Promise<void> {
  const price = positive(quote.priceUsd);
  const mcap = positive(quote.mcapUsd);
  const basis = price != null ? "price" : mcap != null ? "mcap" : null;
  const gain = price != null || mcap != null ? 0 : null;
  const athGain = price != null || mcap != null ? 0 : null;
  await db.execute(sql`UPDATE tokens SET
    entry_price_usd = CASE WHEN entry_at IS NULL THEN ${price} ELSE entry_price_usd END,
    entry_mcap_usd = CASE WHEN entry_at IS NULL THEN ${mcap} ELSE entry_mcap_usd END,
    ath_price_usd = CASE WHEN entry_at IS NULL THEN ${price} ELSE ath_price_usd END,
    ath_mcap_usd = CASE WHEN entry_at IS NULL THEN ${mcap} ELSE ath_mcap_usd END,
    ath_at = CASE WHEN entry_at IS NULL THEN ${quote.at} ELSE ath_at END,
    ath_gain_pct = CASE WHEN entry_at IS NULL THEN ${athGain} ELSE ath_gain_pct END,
    gain_pct = CASE WHEN entry_at IS NULL THEN ${gain} ELSE gain_pct END,
    gain_basis = CASE WHEN entry_at IS NULL THEN ${basis} ELSE gain_basis END,
    entry_at = COALESCE(entry_at, ${quote.at})
  WHERE mint = ${mint}`);
}

/**
 * Copy the immutable candidate first-alert into a still-empty watching entry.
 * Does not touch ATH or gain. No-ops when entry is already set or the token never became a candidate.
 */
export async function copyFirstAlertToEntry(db: AppDb, mint: string): Promise<void> {
  await db.execute(sql`UPDATE tokens SET
    entry_price_usd = first_alert_price_usd,
    entry_mcap_usd = first_alert_mcap_usd,
    entry_at = first_alert_at
  WHERE mint = ${mint}
    AND entry_at IS NULL
    AND first_alert_at IS NOT NULL`);
}

export async function insertCheck(
  db: AppDb,
  row: {
    mint: string;
    stage: string;
    passed: boolean | null;
    flags: unknown;
    payload: unknown;
    checkedAt?: Date;
  },
): Promise<void> {
  const values = {
    mint: row.mint, stage: row.stage, passed: row.passed,
    flags: row.flags, payload: row.payload, checkedAt: row.checkedAt ?? new Date(),
  };
  if (!alertsEnabled()) { await db.insert(tokenChecks).values(values); return; }
  await db.transaction(async tx => {
    const [inserted] = await tx.insert(tokenChecks).values(values).returning();
    await recordCheckAlert(tx, inserted);
  });
}

/** Commit the current reading and its immutable evidence together. */
export async function persistMarketCheck(db: AppDb, mint: string, patch: TokenPatch, row: Parameters<typeof insertCheck>[1]): Promise<void> {
  await db.transaction(async tx => {
    await tx.update(tokens).set(patch).where(eq(tokens.mint,mint));
    const [check] = await tx.insert(tokenChecks).values({mint:row.mint,stage:row.stage,passed:row.passed,flags:row.flags,payload:row.payload,checkedAt:row.checkedAt ?? new Date()}).returning();
    if (alertsEnabled()) await recordCheckAlert(tx,check);
  });
}

export async function listChecks(db: AppDb, mint: string, limit = 40) {
  const result = await db.execute(sql`SELECT id, mint, checked_at, stage, passed, flags, payload
    FROM token_checks WHERE mint = ${mint}
    ORDER BY checked_at DESC
    LIMIT ${limit}`);
  return asRows<{
    id: number | string;
    mint: string;
    checked_at: Date | string;
    stage: string;
    passed: boolean | null;
    flags: unknown;
    payload: unknown;
  }>(result);
}

export async function insertRawEvent(db: AppDb, event: NormalizedEvent): Promise<boolean> {
  const persist = async (tx: Pick<AppDb,"insert"|"update"|"execute">) => {
  const inserted = await tx
    .insert(rawEvents)
    .values({
      signature: event.signature,
      wallet: event.wallet,
      slot: event.slot,
      blockTime: event.blockTime,
      err: event.err,
      programs: event.programs,
      mint: event.mint,
      side: event.side,
      solDelta: event.solDelta,
      tokenDelta: event.tokenDelta,
      rawJson: event.raw,
    })
    .onConflictDoNothing({ target: rawEvents.signature })
    .returning();
  if (inserted.length > 0) {
    await tx.update(wallets).set({ lastIngestAt: new Date() }).where(eq(wallets.address, event.wallet));
  }
  if (alertsEnabled() && inserted[0]?.mint) {
    await captureObservation(tx, inserted[0].mint, `raw:${event.signature}`, inserted[0].ingestedAt, "raw_event", inserted[0], null);
  }
  return inserted.length > 0;
  };
  return alertsEnabled() ? db.transaction(persist) : persist(db);
}

export async function updateRawFromRpc(db: AppDb, event: NormalizedEvent): Promise<void> {
  const persist = async (tx: Pick<AppDb,"update"|"execute">) => {
  const updated = await tx
    .update(rawEvents)
    .set({
      slot: event.slot,
      blockTime: event.blockTime,
      err: event.err,
      programs: event.programs,
      mint: event.mint,
      side: event.side,
      solDelta: event.solDelta,
      tokenDelta: event.tokenDelta,
      rawJson: event.raw,
    })
    .where(eq(rawEvents.signature, event.signature)).returning();
  if (alertsEnabled() && updated[0]?.mint) {
    await captureObservation(tx, updated[0].mint, `rpc:${event.signature}`, new Date(), "parsed_transaction", updated[0], null);
  }
  };
  if (alertsEnabled()) await db.transaction(persist); else await persist(db);
}

export async function getRawEvent(db: AppDb, signature: string) {
  const rows = await db.select().from(rawEvents).where(eq(rawEvents.signature, signature)).limit(1);
  return rows[0] ?? null;
}

export async function enqueueJob(
  db: AppDb,
  type: string,
  payload: Record<string, unknown>,
  runAfter: Date,
): Promise<void> {
  await db.insert(pipelineJobs).values({ type, payload, runAfter, status: "pending", attempts: 0 }).onConflictDoNothing();
}

export type ClaimedJob = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export async function claimJobs(db: AppDb, limit: number): Promise<ClaimedJob[]> {
  const result = await db.execute(sql`WITH cte AS (
    SELECT id FROM pipeline_jobs
    WHERE status = 'pending' AND run_after <= now()
    ORDER BY ${sql.raw(JOB_PRIORITY_SQL)}, run_after, id
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  )
  UPDATE pipeline_jobs AS job
  SET status = 'running', attempts = job.attempts + 1, locked_at = now()
  FROM cte
  WHERE job.id = cte.id
  RETURNING job.id, job.type, job.payload, job.attempts`);
  return asRows<{ id: number | string; type: string; payload: Record<string, unknown>; attempts: number }>(result).map(
    (row) => ({
      id: Number(row.id),
      type: row.type,
      payload: row.payload ?? {},
      attempts: Number(row.attempts),
    }),
  );
}

export async function finishJob(db: AppDb, id: number): Promise<void> {
  await db
    .update(pipelineJobs)
    .set({ status: "done", lockedAt: null, lastError: null })
    .where(eq(pipelineJobs.id, id));
}

export async function releaseJob(db: AppDb, id: number): Promise<void> {
  await db.execute(sql`UPDATE pipeline_jobs
    SET status = 'pending', attempts = GREATEST(attempts - 1, 0), locked_at = NULL
    WHERE id = ${id} AND status = 'running'`);
}

export async function deferJob(db: AppDb, id: number, retryAt: Date): Promise<void> {
  const retryIso = retryAt.toISOString();
  await db.execute(sql`UPDATE pipeline_jobs
    SET status = 'pending',
        attempts = GREATEST(attempts - 1, 0),
        locked_at = NULL,
        run_after = ${retryIso}::timestamptz,
        last_error = NULL
    WHERE id = ${id} AND status = 'running'`);
}

export async function failJob(db: AppDb, id: number, _attempts: number, message: string, retryAt: Date | null): Promise<void> {
  if (!retryAt) {
    await db
      .update(pipelineJobs)
      .set({ status: "failed", lastError: message.slice(0, 500), lockedAt: null })
      .where(eq(pipelineJobs.id, id));
    return;
  }
  await db
    .update(pipelineJobs)
    .set({ status: "pending", runAfter: retryAt, lastError: message.slice(0, 500), lockedAt: null })
    .where(eq(pipelineJobs.id, id));
}

export async function sweepStaleJobs(db: AppDb): Promise<void> {
  await db.execute(sql`UPDATE pipeline_jobs
    SET status = 'pending', locked_at = NULL
    WHERE status = 'running' AND locked_at < now() - interval '2 minutes'`);
}

export async function enabledWallets(db: AppDb, limit: number) {
  const result = await db.execute(sql`SELECT address, label, last_signature, resume_before
    FROM wallets
    WHERE enabled = true
    ORDER BY last_polled_at ASC NULLS FIRST
    LIMIT ${limit}`);
  return asRows<{ address: string; label: string; last_signature: string | null; resume_before: string | null }>(result);
}

export async function markWalletPolled(
  db: AppDb,
  address: string,
  signature: string | null,
  resumeBefore: string | null = null,
): Promise<void> {
  await db
    .update(wallets)
    .set({
      lastPolledAt: new Date(),
      resumeBefore,
      ...(signature ? { lastSignature: signature } : {}),
    })
    .where(eq(wallets.address, address));
}

export async function countProviderCalls(db: AppDb, provider: string, since: Date): Promise<number> {
  const ageMs = Math.max(0, Math.round(Date.now() - since.getTime()));
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM provider_calls
    WHERE provider = ${provider}
      AND created_at >= now() - (${ageMs} * interval '1 millisecond')`);
  return asNumber(asRows<{ n: unknown }>(result)[0]?.n) ?? 0;
}

export async function countPendingJobs(db: AppDb): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM pipeline_jobs WHERE status = 'pending'`);
  return asNumber(asRows<{ n: unknown }>(result)[0]?.n) ?? 0;
}

export async function countGateCalls(db: AppDb, gate: string, since: Date): Promise<number> {
  const ageMs = Math.max(0, Math.round(Date.now() - since.getTime()));
  const result =
    gate === "helius"
      ? await db.execute(sql`SELECT count(*)::int AS n FROM provider_calls
          WHERE provider IN ('helius', 'rpc')
            AND created_at >= now() - (${ageMs} * interval '1 millisecond')`)
      : await db.execute(sql`SELECT count(*)::int AS n FROM provider_calls
          WHERE provider = ${gate}
            AND created_at >= now() - (${ageMs} * interval '1 millisecond')`);
  return asNumber(asRows<{ n: unknown }>(result)[0]?.n) ?? 0;
}

export async function reserveProviderSlot(
  db: AppDb,
  provider: string,
  gapMs: number,
  maxWaitMs: number,
): Promise<{ ok: true; waitMs: number } | { ok: false; retryAfterMs: number; reason: "pace" | "http" }> {
  await db.execute(sql`INSERT INTO provider_slots (provider, next_at)
    VALUES (${provider}, now())
    ON CONFLICT (provider) DO NOTHING`);
  const updated = await db.execute(sql`UPDATE provider_slots AS slot
    SET next_at = GREATEST(slot.next_at, now()) + (${gapMs} * interval '1 millisecond')
    WHERE slot.provider = ${provider}
      AND (slot.backoff_until IS NULL OR slot.backoff_until <= now())
      AND GREATEST(slot.next_at, now()) <= now() + (${maxWaitMs} * interval '1 millisecond')
    RETURNING EXTRACT(EPOCH FROM (next_at - (${gapMs} * interval '1 millisecond') - now())) * 1000 AS wait_ms`);
  const wait = asNumber(asRows<{ wait_ms: unknown }>(updated)[0]?.wait_ms);
  if (wait != null) return { ok: true, waitMs: Math.max(0, wait) };
  const state = await db.execute(sql`SELECT
      EXTRACT(EPOCH FROM (backoff_until - now())) * 1000 AS backoff_ms,
      EXTRACT(EPOCH FROM (next_at - now())) * 1000 AS wait_ms
    FROM provider_slots WHERE provider = ${provider}`);
  const row = asRows<{ backoff_ms: unknown; wait_ms: unknown }>(state)[0];
  const backoff = asNumber(row?.backoff_ms) ?? 0;
  if (backoff > 0) return { ok: false, retryAfterMs: backoff, reason: "http" };
  return { ok: false, retryAfterMs: Math.max(asNumber(row?.wait_ms) ?? maxWaitMs, 1_000), reason: "pace" };
}

export async function noteProviderBackoff(db: AppDb, provider: string, waitMs: number): Promise<void> {
  await db.execute(sql`INSERT INTO provider_slots (provider, next_at, backoff_until)
    VALUES (
      ${provider},
      now() + (${waitMs} * interval '1 millisecond'),
      now() + (${waitMs} * interval '1 millisecond')
    )
    ON CONFLICT (provider) DO UPDATE SET
      backoff_until = GREATEST(COALESCE(provider_slots.backoff_until, now()), EXCLUDED.backoff_until),
      next_at = GREATEST(provider_slots.next_at, EXCLUDED.next_at)`);
}

export async function tryDrainLease(db: AppDb, holder: string): Promise<boolean> {
  await db.execute(sql`INSERT INTO pipeline_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const result = await db.execute(sql`UPDATE pipeline_lock
    SET holder = ${holder}, locked_at = now()
    WHERE id = 1
      AND (
        holder IS NULL
        OR locked_at IS NULL
        OR locked_at < now() - interval '90 seconds'
      )
    RETURNING holder`);
  return asRows<{ holder: string }>(result)[0]?.holder === holder;
}

export async function releaseDrainLease(db: AppDb, holder: string): Promise<void> {
  await db.execute(sql`UPDATE pipeline_lock
    SET holder = NULL, locked_at = NULL
    WHERE id = 1 AND holder = ${holder}`);
}

export async function requeueVersionedParseFailures(db: AppDb): Promise<number> {
  const result = await db.execute(sql`UPDATE pipeline_jobs
    SET status = 'pending', attempts = 0, run_after = now(), locked_at = NULL, last_error = NULL
    WHERE type IN ('parse', 'parse_rpc')
      AND status = 'failed'
      AND (
        COALESCE(last_error, '') ILIKE '%maxSupportedTransactionVersion%'
        OR COALESCE(last_error, '') ILIKE '%transaction version%'
      )
    RETURNING id`);
  return asRows(result).length;
}

export async function backfillOrphanMints(db: AppDb, limit = 40): Promise<number> {
  const result = await db.execute(sql`SELECT DISTINCT ON (event.mint)
      event.mint, event.signature, event.wallet, event.side, event.sol_delta,
      event.block_time, event.ingested_at, event.programs
    FROM raw_events event
    WHERE event.mint IS NOT NULL
      AND event.err = false
      AND event.side IN ('buy', 'sell')
      AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.mint = event.mint)
    ORDER BY event.mint, CASE WHEN event.side = 'buy' THEN 0 ELSE 1 END, event.block_time ASC NULLS LAST
    LIMIT ${limit}`);
  let created = 0;
  for (const row of asRows<{
    mint: string;
    signature: string;
    wallet: string;
    side: string;
    sol_delta: unknown;
    block_time: unknown;
    ingested_at: unknown;
    programs: string[] | null;
  }>(result)) {
    if (!row.mint || isQuoteMint(row.mint)) continue;
    const plan = planDiscovery(row.mint);
    if (plan.action === "ignore") continue;
    const seenAt = asDate(row.block_time) ?? asDate(row.ingested_at) ?? new Date();
    const isBuy = row.side === "buy";
    const spent = asNumber(row.sol_delta);
    const venue = venueFromPrograms(Array.isArray(row.programs) ? row.programs : []);
    const inserted = await insertTokenIfNew(db, {
      mint: row.mint,
      status: plan.action === "reject" ? "rejected_junk" : "seen",
      archiveReason: plan.action === "reject" ? plan.reason : null,
      score: plan.action === "reject" ? 0 : 50,
      firstSeenAt: seenAt,
      sniperBuyTx: isBuy ? row.signature : null,
      sniperBuyAt: isBuy ? seenAt : null,
      sniperBuySol: isBuy && spent != null && spent < 0 ? Math.abs(spent) : null,
      sniperWallet: row.wallet,
      venue: venue.venue,
      graduated: venue.graduated,
    });
    if (!inserted) continue;
    created += 1;
    if (plan.action === "track" && isBuy) await enqueueJob(db, "enrich_t0", { mint: row.mint }, new Date());
  }
  return created;
}

export async function unknownEventCounts(db: AppDb, mints: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (mints.length === 0) return counts;
  const result = await db.execute(sql`SELECT mint, count(*)::int AS n
    FROM raw_events
    WHERE side = 'unknown' AND mint IN (${sql.join(mints.map((mint) => sql`${mint}`), sql`, `)})
    GROUP BY mint`);
  for (const row of asRows<{ mint: string; n: unknown }>(result)) {
    counts.set(row.mint, asNumber(row.n) ?? 0);
  }
  return counts;
}

export async function markPipelineRun(db: AppDb, route: string, phase: "start" | "finish"): Promise<void> {
  if (phase === "start") {
    await db.execute(sql`INSERT INTO pipeline_runs (route, started_at, finished_at)
      VALUES (${route}, now(), NULL)
      ON CONFLICT (route) DO UPDATE SET started_at = now()`);
    return;
  }
  await db.execute(sql`INSERT INTO pipeline_runs (route, started_at, finished_at)
    VALUES (${route}, now(), now())
    ON CONFLICT (route) DO UPDATE SET finished_at = now()`);
}

export async function pendingCountsByType(db: AppDb): Promise<Record<string, number>> {
  const result = await db.execute(sql`SELECT type, count(*)::int AS n
    FROM pipeline_jobs WHERE status = 'pending' GROUP BY type`);
  const counts: Record<string, number> = {};
  for (const row of asRows<{ type: string; n: unknown }>(result)) counts[row.type] = asNumber(row.n) ?? 0;
  return counts;
}

export async function recordProviderCall(db: AppDb, provider: string, status: number): Promise<void> {
  await db.insert(providerCalls).values({ provider, status });
}

export async function readCache<T>(db: AppDb, key: string, ttlMs: number): Promise<T | null> {
  const result = await db.execute(sql`SELECT payload, fetched_at FROM market_cache WHERE cache_key = ${key}`);
  const row = asRows<{ payload: T; fetched_at: string | Date }>(result)[0];
  if (!row) return null;
  const fetched = asDate(row.fetched_at);
  if (!fetched || Date.now() - fetched.getTime() > ttlMs) return null;
  return row.payload;
}

export async function writeCache(db: AppDb, key: string, payload: unknown): Promise<void> {
  await db.execute(sql`INSERT INTO market_cache (cache_key, payload, fetched_at)
    VALUES (${key}, ${JSON.stringify(payload)}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`);
}

/** Rank the complete selected book before limiting; latest-view pagination cannot hide leaders. */
export async function topTokensByStatus(db: AppDb, status: string, rank: "gain" | "volume"): Promise<TokenRecord[]> {
  const metric = rank === "gain" ? tokens.gainPct : tokens.lastVolH1;
  const rows = await db.select().from(tokens)
    .where(and(eq(tokens.status, status), sql`${metric} > 0`))
    .orderBy(desc(metric), asc(tokens.mint)).limit(10);
  return rows.map(row => mapToken(row));
}

export async function listTokensByStatus(db: AppDb, status: string, limit: number, latest = false): Promise<TokenRecord[]> {
  if (latest) {
    const rows = await db.select().from(tokens).where(eq(tokens.status, status))
      .orderBy(sql`first_seen_at DESC NULLS LAST`, asc(tokens.mint)).limit(limit);
    return rows.map((row) => mapToken(row));
  }
  if (status === "candidate") {
    const rows = await db
      .select()
      .from(tokens)
      .where(eq(tokens.status, status))
      .orderBy(
        sql`CASE WHEN cap_regime = 'extended' THEN 1 ELSE 0 END`,
        sql`confidence DESC NULLS LAST`,
        desc(tokens.score),
        sql`first_alert_at ASC NULLS LAST`,
      )
      .limit(limit);
    return rows.map((row) => mapToken(row)).sort(compareCandidates);
  }
  const order =
    status === "watching"
      ? [desc(tokens.score), desc(tokens.gainPct), asc(tokens.entryAt)]
      : status === "archived"
        ? [desc(tokens.archivedAt)]
        : [desc(tokens.firstSeenAt)];
  const rows = await db.select().from(tokens).where(eq(tokens.status, status)).orderBy(...order).limit(limit);
  return rows.map((row) => mapToken(row));
}

export async function searchTokens(db: AppDb, like: string, limit = 50): Promise<TokenRecord[]> {
  const result = await db.execute(sql`SELECT * FROM tokens
    WHERE mint ILIKE ${like} ESCAPE '\\'
      OR COALESCE(symbol, '') ILIKE ${like} ESCAPE '\\'
      OR COALESCE(name, '') ILIKE ${like} ESCAPE '\\'
      OR COALESCE(sniper_wallet, '') ILIKE ${like} ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM raw_events event
        WHERE event.mint = tokens.mint AND event.wallet ILIKE ${like} ESCAPE '\\'
      )
    ORDER BY score DESC NULLS LAST, first_seen_at DESC NULLS LAST
    LIMIT ${limit}`);
  return asRows<Record<string, unknown>>(result).map((row) => mapToken(row));
}

export async function searchWallets(db: AppDb, like: string) {
  const result = await db.execute(sql`SELECT address, label, enabled FROM wallets
    WHERE address ILIKE ${like} ESCAPE '\\' OR label ILIKE ${like} ESCAPE '\\'
    LIMIT 10`);
  return asRows<{ address: string; label: string; enabled: boolean }>(result);
}

export async function recentBuys(db: AppDb, limit: number) {
  const result = await db.execute(sql`SELECT
      event.signature, event.wallet, wallet.label AS wallet_label, event.mint, token.symbol,
      token.name, token.image_url, token.venue, token.status, event.side, event.sol_delta, event.token_delta,
      event.block_time, event.ingested_at, event.err, event.programs,
      token.entry_at, token.entry_price_usd, token.entry_mcap_usd, token.last_price_usd, token.last_mcap_usd
    FROM raw_events event
    LEFT JOIN wallets wallet ON wallet.address = event.wallet
    LEFT JOIN tokens token ON token.mint = event.mint
    WHERE event.side = 'buy' AND event.err = false
    ORDER BY COALESCE(event.block_time, event.ingested_at) DESC
    LIMIT ${limit}`);
  return asRows<Record<string, unknown>>(result);
}

export async function walletRows(db: AppDb) {
  const result = await db.execute(sql`SELECT
      wallet.address, wallet.label, wallet.enabled, wallet.created_at, wallet.last_ingest_at, wallet.last_polled_at,
      (SELECT count(*)::int FROM raw_events event
        WHERE event.wallet = wallet.address AND event.ingested_at > now() - interval '24 hours') AS events_24h,
      (SELECT count(*)::int FROM raw_events event
        WHERE event.wallet = wallet.address AND event.ingested_at > now() - interval '1 hour') AS events_1h
    FROM wallets wallet
    ORDER BY wallet.created_at ASC`);
  return asRows<Record<string, unknown>>(result);
}

/** Check age is a monitoring proxy, not proof of upstream quote freshness. */
export async function watchingFreshness(db: AppDb) {
  const result = await db.execute(sql`SELECT
    count(*)::int AS total,
    (count(*) FILTER (WHERE last_checked_at IS NULL))::int AS never_checked,
    (count(*) FILTER (WHERE last_checked_at IS NULL OR last_checked_at < now() - interval '30 minutes'))::int AS stale_30m,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM now() - last_checked_at)) AS p50_age_seconds,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM now() - last_checked_at)) AS p95_age_seconds
    FROM tokens WHERE status = 'watching'`);
  const row = asRows<Record<string, unknown>>(result)[0];
  return {
    total: asNumber(row?.total) ?? 0,
    neverChecked: asNumber(row?.never_checked) ?? 0,
    stale30m: asNumber(row?.stale_30m) ?? 0,
    p50CheckAgeSeconds: asNumber(row?.p50_age_seconds),
    p95CheckAgeSeconds: asNumber(row?.p95_age_seconds),
  };
}

export async function gainRefreshMints(db: AppDb, limit: number): Promise<string[]> {
  const result = await db.execute(sql`SELECT mint FROM tokens
    WHERE status IN ('watching', 'candidate')
    ORDER BY last_checked_at ASC NULLS FIRST, score DESC, mint ASC
    LIMIT ${limit}`);
  return asRows<{ mint: string }>(result).map((row) => row.mint);
}

export async function archiveCandidates(db: AppDb, limit: number): Promise<string[]> {
  const result = await db.execute(sql`SELECT mint FROM tokens
    WHERE status IN ('watching', 'candidate')
      AND (last_checked_at IS NULL OR last_checked_at < now() - interval '20 minutes')
    ORDER BY last_checked_at ASC NULLS FIRST
    LIMIT ${limit}`);
  return asRows<{ mint: string }>(result).map((row) => row.mint);
}

export async function reviveCandidates(db: AppDb, limit: number): Promise<string[]> {
  const result = await db.execute(sql`SELECT mint FROM tokens
    WHERE status = 'archived'
      AND (archived_at IS NULL OR archived_at > now() - interval '14 days')
    ORDER BY last_checked_at ASC NULLS FIRST
    LIMIT ${limit}`);
  return asRows<{ mint: string }>(result).map((row) => row.mint);
}

export async function pruneStorage(db: AppDb): Promise<void> {
  // Raw discovery evidence is retained for review/export; do not silently delete it.
  await db.execute(sql`DELETE FROM provider_calls WHERE created_at < now() - interval '2 days'`);
  await db.execute(sql`DELETE FROM market_cache WHERE fetched_at < now() - interval '1 day'`);
  await db.execute(sql`DELETE FROM pipeline_jobs
    WHERE status IN ('done', 'failed') AND created_at < now() - interval '3 days'`);
}

const BREAKDOWN_SUM = `(
  COALESCE((score_breakdown->>'base')::float, 0)
  + COALESCE((score_breakdown->>'liquidity')::float, 0)
  + COALESCE((score_breakdown->>'volume')::float, 0)
  + COALESCE((score_breakdown->>'buyPressure')::float, 0)
  + COALESCE((score_breakdown->>'holders')::float, 0)
  + COALESCE((score_breakdown->>'authorities')::float, 0)
  + COALESCE((score_breakdown->>'rugcheck')::float, 0)
  + COALESCE((score_breakdown->>'sniperHold')::float, 0)
  + COALESCE((score_breakdown->>'age')::float, 0)
  + COALESCE((score_breakdown->>'venue')::float, 0)
  + COALESCE((score_breakdown->>'drawdown')::float, 0)
)`;

export async function dataQualityCounts(db: AppDb) {
  const result = await db.execute(sql.raw(`SELECT
      (count(*) FILTER (WHERE pair_count IS NULL OR pair_count <= 0))::int AS no_dex_pair,
      (count(*) FILTER (WHERE last_mcap_usd IS NULL))::int AS no_mcap,
      (count(*) FILTER (WHERE last_liq_usd IS NULL))::int AS no_liquidity,
      (count(*) FILTER (WHERE top_holder_pct IS NULL))::int AS no_holders,
      (count(*) FILTER (WHERE rugcheck_normalised IS NULL))::int AS no_rugcheck,
      (count(*) FILTER (WHERE mint_revoked IS NULL AND freeze_revoked IS NULL))::int AS no_authorities,
      (count(*) FILTER (WHERE sniper_buy_tx IS NULL OR btrim(sniper_buy_tx) = ''))::int AS parse_failed,
      (count(*) FILTER (WHERE entry_at IS NULL))::int AS no_entry,
      (count(*) FILTER (WHERE first_alert_at IS NULL))::int AS no_first_alert,
      (count(*) FILTER (WHERE last_checked_at IS NULL OR last_checked_at < now() - interval '30 minutes'))::int AS stale_market_data,
      (count(*) FILTER (WHERE socials IS NULL OR (
        COALESCE(socials->>'website', '') = ''
        AND COALESCE(socials->>'twitter', '') = ''
        AND COALESCE(socials->>'telegram', '') = ''
      )))::int AS no_socials,
      (count(*) FILTER (WHERE image_url IS NULL OR btrim(image_url) = ''))::int AS no_image,
      (count(*) FILTER (WHERE score_breakdown IS NOT NULL AND (
        (top_holder_pct IS NULL AND COALESCE((score_breakdown->>'holders')::float, -1) = 5)
        OR (mint_revoked IS NULL AND freeze_revoked IS NULL AND COALESCE((score_breakdown->>'authorities')::float, -1) = 5)
        OR (rugcheck_normalised IS NULL AND COALESCE((score_breakdown->>'rugcheck')::float, -1) = 4)
      )))::int AS safety_unknown_scored_neutral,
      (count(*) FILTER (WHERE entry_at IS NOT NULL AND first_seen_at IS NOT NULL AND entry_at > first_seen_at + interval '15 minutes'))::int AS late_entry,
      (count(*) FILTER (WHERE score_breakdown IS NOT NULL AND ${BREAKDOWN_SUM} >= 100))::int AS score_capped,
      (count(*) FILTER (WHERE promotion_hits IS NOT NULL AND (
        SELECT array_agg(DISTINCT btrim(part) ORDER BY btrim(part))
        FROM unnest(string_to_array(promotion_hits, ',')) AS part
        WHERE btrim(part) <> ''
      ) = ARRAY['alive', 'liq']::text[]))::int AS weak_watch_promotion,
      (count(*) FILTER (WHERE last_mcap_usd > 5000000))::int AS cap_above_low_cap_band,
      (count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM raw_events event WHERE event.mint = tokens.mint AND event.side = 'unknown'
      )))::int AS parse_gap
    FROM tokens`));
  return asRows<Record<string, unknown>>(result)[0] ?? {};
}

export async function pipelineStats(db: AppDb) {
  const [queues, types, depths, tokenCounts, usage, throttles, ingest, runs, quality] = await Promise.all([
    db.execute(sql`SELECT status, count(*)::int AS n FROM pipeline_jobs GROUP BY status`),
    db.execute(sql`SELECT type, count(*)::int AS n FROM pipeline_jobs WHERE status = 'pending' GROUP BY type`),
    db.execute(sql`SELECT type, status, count(*)::int AS n FROM pipeline_jobs GROUP BY type, status`),
    db.execute(sql`SELECT status, count(*)::int AS n FROM tokens GROUP BY status`),
    db.execute(sql`SELECT provider, count(*)::int AS n FROM provider_calls
      WHERE created_at >= now() - interval '1 minute' GROUP BY provider`),
    db.execute(sql`SELECT provider, max(created_at) AS at FROM provider_calls
      WHERE status = 429 AND created_at >= now() - interval '1 day' GROUP BY provider`),
    db.execute(sql`SELECT max(ingested_at) AS at FROM raw_events`),
    db.execute(sql`SELECT route, started_at, finished_at FROM pipeline_runs ORDER BY route`),
    dataQualityCounts(db),
  ]);
  return {
    queues: asRows<{ status: string; n: number }>(queues),
    types: asRows<{ type: string; n: number }>(types),
    depths: asRows<{ type: string; status: string; n: number }>(depths),
    tokenCounts: asRows<{ status: string; n: number }>(tokenCounts),
    usage: asRows<{ provider: string; n: number }>(usage),
    throttles: asRows<{ provider: string; at: string | Date | null }>(throttles),
    lastIngestAt: asDate(asRows<{ at: string | Date | null }>(ingest)[0]?.at),
    runs: asRows<{ route: string; started_at: string | Date | null; finished_at: string | Date | null }>(runs),
    quality,
  };
}

export async function watchedAddressSet(db: AppDb): Promise<Set<string>> {
  const rows = await db.select({ address: wallets.address }).from(wallets).where(eq(wallets.enabled, true));
  return new Set(rows.map((row) => row.address));
}

export { and, asc, desc, eq, wallets, tokens, rawEvents };
