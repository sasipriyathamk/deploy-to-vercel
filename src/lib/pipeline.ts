import { flushAlerts } from "@/lib/alerts/telegram";
import { runShadowVerdictBatch } from "@/lib/ai/run";
import type { AppDb } from "@/lib/db/index";
import {
  archiveCandidates,
  backfillOrphanMints,
  claimJobs,
  countPendingJobs,
  deferJob,
  enabledWallets,
  enqueueJob,
  failJob,
  finishJob,
  gainRefreshMints,
  getRawEvent,
  getToken,
  insertCheck,
  persistMarketCheck,
  insertRawEvent,
  insertTokenIfNew,
  markPipelineRun,
  markWalletPolled,
  pendingCountsByType,
  pruneStorage,
  releaseDrainLease,
  releaseJob,
  requeueVersionedParseFailures,
  reviveCandidates,
  copyFirstAlertToEntry,
  sweepStaleJobs,
  tryDrainLease,
  updateRawFromRpc,
  updateToken,
  watchedAddressSet,
  type ClaimedJob,
  type TokenPatch,
  type TokenRecord,
} from "@/lib/db/repo";
import {
  performanceAnchor,
  positive,
  resolveGain,
  stampFirstAlert,
  updateAth,
  type FirstAlertFields,
  type GainResult,
} from "@/lib/logic/gains";
import {
  buildConfidence,
  isClearDeadMarket,
  isWeakTick,
  publishReading,
  reviewCandidate,
  stampCheckpoint,
  type CheckpointStage,
} from "@/lib/logic/confidence";
import {
  decideArchive,
  decideT0,
  decideT15,
  decideT5,
  isLifeless,
  nextWeakSince,
  shouldRevive,
  type MarketSnapshot,
} from "@/lib/logic/funnel";
import { planDiscovery } from "@/lib/logic/junk";
import {
  applyExternalTrade,
  coerceWebhookBody,
  isVersionedTxError,
  normalizeHelius,
  normalizeRpc,
  shouldDiscoverToken,
  type NormalizedEvent,
  type RpcTransaction,
} from "@/lib/logic/parse";
import { hasStoredSocials } from "@/lib/logic/quality";
import { planSignatureCheckpoint } from "@/lib/logic/queue";
import { newSignatures } from "@/lib/logic/dedupe";
import { scoreToken, type ScoreBreakdown } from "@/lib/logic/score";
import { missingMetadata } from "@/lib/logic/metadata";
import { mergeVenue, venueFromPrograms } from "@/lib/logic/venue";
import {
  emptySnapshot,
  findExternalTrade,
  getDexSnapshots,
  getEnhancedTransaction,
  getJupiterPrices,
  getParsedTransaction,
  getSignatures,
  getTransaction,
  loadMarket,
  loadRug,
  redactSecrets,
  tokenBalance,
  type RugReport,
  RateLimitError,
} from "@/lib/market";

const HOUR = 60 * 60_000;

function defined<T extends Record<string, unknown>>(patch: T): TokenPatch {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next as TokenPatch;
}

function performanceOf(
  token: TokenRecord,
  snap: MarketSnapshot,
  now: Date,
  anchor: { at: Date; priceUsd: number | null; mcapUsd: number | null },
): {
  gain: GainResult;
  athPriceUsd: number | null;
  athMcapUsd: number | null;
  athGainPct: number | null;
  athAt: Date | null;
} {
  const price = positive(snap.priceUsd);
  const mcap = positive(snap.mcapUsd);
  const gain = resolveGain({
    lastPrice: price,
    entryPrice: anchor.priceUsd,
    lastMcap: mcap,
    entryMcap: anchor.mcapUsd,
  });
  const kept =
    gain.gainPct == null && token.gainPct != null
      ? { gainPct: token.gainPct, basis: token.gainBasis }
      : gain;
  const ath = updateAth({
    entryAt: anchor.at,
    entryPriceUsd: anchor.priceUsd,
    entryMcapUsd: anchor.mcapUsd,
    athPriceUsd: token.athPriceUsd,
    athMcapUsd: token.athMcapUsd,
    athAt: token.athAt,
    priceUsd: price,
    mcapUsd: mcap,
    observedAt: now,
  });
  return { gain: kept, ...ath };
}

function alertFields(token: TokenRecord, alert: FirstAlertFields | null): FirstAlertFields {
  if (token.firstAlertAt) {
    return {
      firstAlertAt: token.firstAlertAt,
      firstAlertPriceUsd: token.firstAlertPriceUsd,
      firstAlertMcapUsd: token.firstAlertMcapUsd,
    };
  }
  return alert ?? { firstAlertAt: null, firstAlertPriceUsd: null, firstAlertMcapUsd: null };
}

function scoreFrom(
  token: TokenRecord,
  snap: MarketSnapshot,
  rug: RugReport | null,
  now: Date,
  entryAt: Date | null,
  athPrice: number | null,
): ScoreBreakdown {
  return scoreToken({
    liqUsd: snap.liqUsd,
    volM5: snap.volM5,
    volH1: snap.volH1,
    buysM5: snap.buysM5,
    sellsM5: snap.sellsM5,
    buysH1: snap.buysH1,
    sellsH1: snap.sellsH1,
    topHolderPct: rug?.topHolderPct ?? token.topHolderPct,
    mintRevoked: rug?.mintRevoked ?? token.mintRevoked,
    freezeRevoked: rug?.freezeRevoked ?? token.freezeRevoked,
    rugcheckNormalised: rug?.normalised ?? token.rugcheckNormalised,
    sniperHolding: token.sniperStillHolding,
    entryAt,
    now,
    venue: mergeVenue(token.venue, token.graduated, snap.dexId).venue,
    graduated: mergeVenue(token.venue, token.graduated, snap.dexId).graduated,
    lastPriceUsd: positive(snap.priceUsd),
    athPriceUsd: athPrice,
  });
}

function marketPatch(
  token: TokenRecord,
  snap: MarketSnapshot,
  rug: RugReport | null,
  now: Date,
  options: { keepPerformance: boolean; alert?: FirstAlertFields | null; stage?: CheckpointStage },
): TokenPatch {
  const venue = mergeVenue(token.venue, token.graduated, snap.dexId);
  const alert = alertFields(token, options.alert ?? null);
  const anchor = performanceAnchor({
    entryAt: token.entryAt,
    entryPriceUsd: token.entryPriceUsd,
    entryMcapUsd: token.entryMcapUsd,
    ...alert,
  });
  const priced = options.keepPerformance || !anchor ? null : performanceOf(token, snap, now, anchor);
  const entryForScore = token.entryAt ?? alert.firstAlertAt;
  const athPrice = priced?.athPriceUsd ?? token.athPriceUsd;
  const score = scoreFrom(token, snap, rug, now, entryForScore, athPrice);
  const publishedScore = publishReading({
    established: token.scoreBreakdown != null,
    current: token.score,
    pending: token.scorePending,
    next: score.total,
  });
  const observedPrice = positive(snap.priceUsd);
  const observedMcap = positive(snap.mcapUsd);
  const sinceAlertGain = resolveGain({
    lastPrice: observedPrice,
    entryPrice: alert.firstAlertPriceUsd,
    lastMcap: observedMcap,
    entryMcap: alert.firstAlertMcapUsd,
  }).gainPct;
  const alertPath = options.stage ? stampCheckpoint(token.alertPath, options.stage, sinceAlertGain) : null;
  const confidence = buildConfidence({
    now,
    firstAlertAt: alert.firstAlertAt,
    lastPriceUsd: observedPrice,
    lastMcapUsd: observedMcap,
    firstAlertPriceUsd: alert.firstAlertPriceUsd,
    firstAlertMcapUsd: alert.firstAlertMcapUsd,
    athPriceUsd: athPrice,
    athMcapUsd: priced?.athMcapUsd ?? token.athMcapUsd,
    liqUsd: snap.liqUsd,
    volM5: snap.volM5,
    volH1: snap.volH1,
    t5VolM5: token.t5VolM5,
    topHolderPct: rug?.topHolderPct ?? token.topHolderPct,
    mintRevoked: rug?.mintRevoked ?? token.mintRevoked,
    freezeRevoked: rug?.freezeRevoked ?? token.freezeRevoked,
    rugcheckNormalised: rug?.normalised ?? token.rugcheckNormalised,
    alertPath: alertPath ?? token.alertPath,
  });
  const publishedConfidence = publishReading({
    established: token.confidence != null,
    current: token.confidence ?? confidence.confidence,
    pending: token.confidencePending,
    next: confidence.confidence,
  });
  const commitConfidence = token.confidence == null || publishedConfidence.pending == null;
  const freshAlert = !token.firstAlertAt && alert.firstAlertAt ? alert : null;
  return defined({
    ...missingMetadata(token, snap),
    decimals: token.decimals,
    venue: venue.venue,
    graduated: venue.graduated,
    pairCount: snap.pairCount || token.pairCount,
    lastBuyersEstimate: snap.buysM5 ?? token.lastBuyersEstimate,
    lastCheckedAt: now,
    firstSeenPriceUsd: token.firstSeenPriceUsd ?? positive(snap.priceUsd),
    firstSeenMcapUsd: token.firstSeenMcapUsd ?? positive(snap.mcapUsd),
    sniperBuyPriceUsd: token.sniperBuyPriceUsd ?? positive(snap.priceUsd),
    sniperBuyMcapUsd: token.sniperBuyMcapUsd ?? positive(snap.mcapUsd),
    weakSince: nextWeakSince(token.weakSince, snap.liqUsd ?? token.lastLiqUsd, snap.volH1 ?? token.lastVolH1, now),
    lastPriceUsd: snap.priceUsd,
    lastMcapUsd: snap.mcapUsd,
    lastLiqUsd: snap.liqUsd,
    lastVolM5: snap.volM5,
    lastVolH1: snap.volH1,
    lastBuysM5: snap.buysM5,
    lastSellsM5: snap.sellsM5,
    lastBuysH1: snap.buysH1,
    lastSellsH1: snap.sellsH1,
    gainPct: priced ? priced.gain.gainPct : undefined,
    gainBasis: priced ? priced.gain.basis : undefined,
    athPriceUsd: priced ? priced.athPriceUsd : undefined,
    athMcapUsd: priced ? priced.athMcapUsd : undefined,
    athGainPct: priced ? priced.athGainPct : undefined,
    athAt: priced ? priced.athAt : undefined,
    score: publishedScore.value,
    scorePending: publishedScore.pending,
    scoreBreakdown:
      token.scoreBreakdown == null || publishedScore.pending == null
        ? { ...score, total: publishedScore.value }
        : token.scoreBreakdown,
    topHolderPct: rug?.topHolderPct ?? token.topHolderPct,
    mintRevoked: rug?.mintRevoked ?? token.mintRevoked,
    freezeRevoked: rug?.freezeRevoked ?? token.freezeRevoked,
    rugcheckNormalised: rug?.normalised ?? token.rugcheckNormalised,
    socials: hasStoredSocials(token.socials) ? undefined : hasStoredSocials(snap.socials) ? snap.socials : undefined,
    firstAlertAt: freshAlert?.firstAlertAt,
    firstAlertPriceUsd: freshAlert?.firstAlertPriceUsd,
    firstAlertMcapUsd: freshAlert?.firstAlertMcapUsd,
    confidence: publishedConfidence.value,
    confidencePending: publishedConfidence.pending,
    confidenceReasons: commitConfidence ? confidence.reasons : undefined,
    capRegime: confidence.regime,
    alertPath: alertPath ?? undefined,
  });
}

function skipPerformance(token: TokenRecord, alert: FirstAlertFields | null): boolean {
  return (
    performanceAnchor({
      entryAt: token.entryAt,
      entryPriceUsd: token.entryPriceUsd,
      entryMcapUsd: token.entryMcapUsd,
      ...alertFields(token, alert),
    }) == null
  );
}

function noteCandidate(
  token: TokenRecord,
  snap: MarketSnapshot,
  patch: TokenPatch,
  now: Date,
  allowDemote: boolean,
): { demote: boolean; reason: string | null } {
  if (token.status !== "candidate") return { demote: false, reason: null };
  const weak = isWeakTick({
    liqUsd: snap.liqUsd,
    volH1: snap.volH1,
    buysM5: snap.buysM5,
    buysH1: snap.buysH1,
  });
  const alertPrice = patch.firstAlertPriceUsd ?? token.firstAlertPriceUsd;
  const alertMcap = patch.firstAlertMcapUsd ?? token.firstAlertMcapUsd;
  const review = reviewCandidate({
    weakRechecks: token.weakRechecks,
    weak,
    clearDead: isClearDeadMarket({
      priceUsd: snap.priceUsd,
      mcapUsd: snap.mcapUsd,
      anchorPriceUsd: alertPrice ?? token.firstSeenPriceUsd,
      anchorMcapUsd: alertMcap ?? token.firstSeenMcapUsd,
      buysM5: snap.buysM5,
      sellsM5: snap.sellsM5,
    }),
    lifeless: isLifeless(snap),
    timedArchive: decideArchive({
      status: "candidate",
      now,
      weakSince: patch.weakSince === undefined ? token.weakSince : patch.weakSince,
      liqUsd: snap.liqUsd,
      volH1: snap.volH1,
      entryAt: token.entryAt ?? patch.firstAlertAt ?? token.firstAlertAt,
      gainPct: patch.gainPct === undefined ? token.gainPct : patch.gainPct,
      buysM5: snap.buysM5 ?? token.lastBuysM5,
      sellsM5: snap.sellsM5 ?? token.lastSellsM5,
    }),
    allowDemote,
  });
  patch.weakRechecks = review.weakRechecks;
  return { demote: review.demote, reason: review.reason };
}

async function safeRug(db: AppDb, mint: string): Promise<RugReport | null> {
  try {
    return await loadRug(db, mint);
  } catch (error) {
    console.warn(`[keel] rugcheck skipped for ${mint}`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function followups(db: AppDb, mint: string, jobs: { type: string; delayMs: number; retry?: boolean }[]): Promise<void> {
  const now = Date.now();
  for (const job of jobs) {
    await enqueueJob(db, job.type, { mint, ...(job.retry ? { retry: true } : {}) }, new Date(now + job.delayMs));
  }
}

async function discover(db: AppDb, event: NormalizedEvent, watched: Set<string>): Promise<void> {
  if (!shouldDiscoverToken(event, watched) || !event.mint) return;
  const plan = planDiscovery(event.mint);
  if (plan.action === "ignore") return;
  const seenAt = event.blockTime ?? new Date();
  const spent = event.solDelta != null && event.solDelta < 0 ? Math.abs(event.solDelta) : null;
  if (plan.action === "reject") {
    const created = await insertTokenIfNew(db, {
      mint: event.mint,
      status: "rejected_junk",
      archiveReason: plan.reason,
      score: 0,
      firstSeenAt: seenAt,
      sniperBuyTx: event.signature,
      sniperBuyAt: seenAt,
      sniperBuySol: spent,
      sniperWallet: event.wallet,
      decimals: event.decimals,
      venue: event.venue.venue,
      graduated: event.venue.graduated,
    });
    if (created) {
      await insertCheck(db, {
        mint: event.mint,
        stage: "t0",
        passed: false,
        flags: { reason: plan.reason },
        payload: { signature: event.signature },
      });
    }
    return;
  }
  const created = await insertTokenIfNew(db, {
    mint: event.mint,
    status: "seen",
    score: 50,
    firstSeenAt: seenAt,
    sniperBuyTx: event.signature,
    sniperBuyAt: seenAt,
    sniperBuySol: spent,
    sniperWallet: event.wallet,
    decimals: event.decimals,
    venue: event.venue.venue,
    graduated: event.venue.graduated,
  });
  if (created) await enqueueJob(db, "enrich_t0", { mint: event.mint }, new Date());
}

export async function ingestHelius(db: AppDb, body: unknown): Promise<{ received: number; stored: number; queued: number }> {
  const watched = await watchedAddressSet(db);
  let stored = 0;
  let queued = 0;
  const txs = coerceWebhookBody(body);
  for (const tx of txs) {
    const event = normalizeHelius(tx, watched);
    if (!event) continue;
    const fresh = await insertRawEvent(db, event);
    if (!fresh) continue;
    stored += 1;
    if (shouldDiscoverToken(event, watched)) {
      await enqueueJob(db, "parse", { signature: event.signature }, new Date());
      queued += 1;
    }
  }
  return { received: txs.length, stored, queued };
}

async function runParse(db: AppDb, signature: string): Promise<void> {
  const row = await getRawEvent(db, signature);
  if (!row || row.err || row.side !== "buy" || !row.mint) return;
  const watched = await watchedAddressSet(db);
  const event: NormalizedEvent = {
    signature: row.signature,
    slot: row.slot,
    blockTime: row.blockTime,
    err: row.err,
    programs: row.programs ?? [],
    source: null,
    wallet: row.wallet,
    mint: row.mint,
    side: "buy",
    solDelta: row.solDelta,
    tokenDelta: row.tokenDelta,
    decimals: null,
    venue: venueFromPrograms(row.programs ?? []),
    raw: row.rawJson,
  };
  await discover(db, event, watched);
}

function tradeResolved(event: NormalizedEvent | null): boolean {
  return Boolean(event && !event.err && event.mint && event.side !== "unknown");
}

async function readChainTransaction(db: AppDb, signature: string): Promise<unknown | null> {
  try {
    const tx = await getTransaction(db, signature);
    if (tx) return tx;
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    if (!isVersionedTxError(error)) {
      // The parsed method is the second chance for a null or a versioned payload.
    }
  }
  try {
    return await getParsedTransaction(db, signature);
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    return null;
  }
}

async function eventFromFallbacks(
  db: AppDb,
  signature: string,
  wallet: string,
  base: NormalizedEvent | null,
): Promise<NormalizedEvent | null> {
  try {
    const enhanced = await getEnhancedTransaction(db, signature);
    if (enhanced) {
      const event = normalizeHelius({ ...enhanced, signature: enhanced.signature ?? signature }, new Set([wallet]));
      if (event?.mint && event.side !== "unknown") return { ...event, wallet };
    }
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
  }
  if (!base?.mint) return null;
  try {
    const trade = await findExternalTrade(db, base.mint, signature, wallet);
    if (!trade) return null;
    return applyExternalTrade(base, trade, wallet, signature);
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    return null;
  }
}

async function runParseRpc(db: AppDb, signature: string): Promise<void> {
  const row = await getRawEvent(db, signature);
  if (!row) return;
  if (row.mint && row.side !== "unknown" && !row.err) {
    if (row.side === "buy") await runParse(db, signature);
    return;
  }
  const tx = await readChainTransaction(db, signature);
  let event = tx && typeof tx === "object" ? normalizeRpc(tx as RpcTransaction, row.wallet, signature) : null;
  if (!tradeResolved(event)) {
    const fallback = await eventFromFallbacks(db, signature, row.wallet, event);
    if (fallback) event = fallback;
  }
  if (!event) throw new Error("RPC returned null for transaction");
  await updateRawFromRpc(db, event);
  const watched = await watchedAddressSet(db);
  if (!event.err) await discover(db, event, watched);
  if (event.mint && event.tokenAfter != null && !event.err) {
    await updateToken(db, event.mint, { sniperStillHolding: event.tokenAfter > 0 });
  }
}

async function runT0(db: AppDb, mint: string, retried: boolean): Promise<void> {
  const token = await getToken(db, mint);
  if (!token || token.status === "rejected_junk" || token.status === "archived") return;
  const snap = await loadMarket(db, mint, true);
  const now = new Date();
  const decision = decideT0({ pairCount: snap.pairCount, retried, firstSeenAt: token.firstSeenAt, now });
  if (decision.action === "retry") {
    await followups(db, mint, decision.followups);
    await insertCheck(db, { mint, stage: "t0", passed: false, flags: { pairCount: 0, retry: true }, payload: snap });
    return;
  }
  if (decision.action === "reject") {
    await updateToken(db, mint, { status: "rejected_junk", archiveReason: decision.reason, lastCheckedAt: now, pairCount: 0 });
    await insertCheck(db, { mint, stage: "t0", passed: false, flags: { reason: decision.reason }, payload: snap });
    return;
  }
  const alert =
    token.status === "seen"
      ? stampFirstAlert(
          {
            firstAlertAt: token.firstAlertAt,
            firstAlertPriceUsd: token.firstAlertPriceUsd,
            firstAlertMcapUsd: token.firstAlertMcapUsd,
          },
          { at: now, priceUsd: snap.priceUsd, mcapUsd: snap.mcapUsd },
        )
      : null;
  const patch = marketPatch(token, snap, null, now, {
    keepPerformance: skipPerformance(token, alert),
    alert,
  });
  patch.status = token.status === "seen" ? "candidate" : token.status;
  await updateToken(db, mint, patch);
  await followups(db, mint, decision.followups);
  await insertCheck(db, { mint, stage: "t0", passed: true, flags: { pairCount: snap.pairCount }, payload: snap });
}

async function runT5(db: AppDb, mint: string, retried: boolean): Promise<void> {
  const token = await getToken(db, mint);
  if (!token || token.status === "rejected_junk" || token.status === "archived") return;
  const snap = await loadMarket(db, mint, true);
  const rug = await safeRug(db, mint);
  const now = new Date();
  const decision = decideT5({ snap, retried, firstSeenAt: token.firstSeenAt, now });
  const patch = marketPatch(token, snap, rug, now, { keepPerformance: skipPerformance(token, null), stage: "t5" });
  if (token.t5VolM5 == null) patch.t5VolM5 = snap.volM5;
  let passed = decision.passed;
  if (decision.action === "archive") {
    patch.status = "archived";
    patch.archiveReason = decision.reason;
    patch.archivedAt = now;
    passed = false;
  } else if (token.status === "candidate") {
    const review = noteCandidate(token, snap, patch, now, false);
    if (review.demote) {
      patch.status = "archived";
      patch.archiveReason = review.reason;
      patch.archivedAt = now;
      passed = false;
    }
  }
  await updateToken(db, mint, patch);
  if (decision.action !== "archive" && patch.status !== "archived") await followups(db, mint, decision.followups);
  await insertCheck(db, {
    mint,
    stage: "t5",
    passed,
    flags: decision.flags,
    payload: { snap, score: patch.scoreBreakdown },
  });
}

async function maybeFillEntryPrice(db: AppDb, mint: string, snap: MarketSnapshot): Promise<MarketSnapshot> {
  if (positive(snap.priceUsd)) return snap;
  try {
    const prices = await getJupiterPrices(db, [mint]);
    const price = prices.get(mint);
    if (!price) return snap;
    return { ...snap, priceUsd: price.priceUsd, liqUsd: snap.liqUsd ?? price.liquidity };
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    return snap;
  }
}

async function runT15(db: AppDb, mint: string): Promise<void> {
  const token = await getToken(db, mint);
  if (!token || token.status === "rejected_junk" || token.status === "archived") return;
  let snap = await loadMarket(db, mint, false);
  const rug = await safeRug(db, mint);
  const now = new Date();
  let decision = decideT15({
    liqUsd: snap.liqUsd,
    volH1: snap.volH1,
    volM5: snap.volM5,
    t5VolM5: token.t5VolM5,
    buysM5: snap.buysM5,
    buyersEstimate: snap.buysM5,
    priceUsd: snap.priceUsd,
    mcapUsd: snap.mcapUsd,
    firstSeenPrice: token.firstSeenPriceUsd,
    firstSeenAt: token.firstSeenAt,
    now,
    alreadyWatching: token.status === "watching" || token.entryAt != null,
  });
  if (decision.promote) snap = await maybeFillEntryPrice(db, mint, snap);
  decision = decideT15({
    ...decision,
    liqUsd: snap.liqUsd,
    volH1: snap.volH1,
    volM5: snap.volM5,
    buysM5: snap.buysM5,
    buyersEstimate: snap.buysM5,
    priceUsd: snap.priceUsd,
    mcapUsd: snap.mcapUsd,
    t5VolM5: token.t5VolM5,
    firstSeenPrice: token.firstSeenPriceUsd,
    firstSeenAt: token.firstSeenAt,
    now,
    alreadyWatching: token.status === "watching" || token.entryAt != null,
  });
  const patch = marketPatch(token, snap, rug, now, { keepPerformance: skipPerformance(token, null), stage: "t15" });
  const review = token.status === "candidate" ? noteCandidate(token, snap, patch, now, false) : { demote: false, reason: null };
  let promoted = false;
  if (review.demote) {
    patch.status = "archived";
    patch.archiveReason = review.reason;
    patch.archivedAt = now;
  } else if (decision.promote) {
    patch.status = "watching";
    patch.promotionHits = decision.hits.join(",");
    promoted = true;
  }
  await updateToken(db, mint, patch);
  if (promoted && !token.entryAt) await copyFirstAlertToEntry(db, mint);
  if (patch.status !== "archived") await followups(db, mint, decision.followups);
  await insertCheck(db, {
    mint,
    stage: "t15",
    passed: decision.passed && !review.demote,
    flags: { hits: decision.hits.join(","), promoted, demoted: review.demote },
    payload: { snap, score: patch.scoreBreakdown },
  });
}

async function runT60(db: AppDb, mint: string): Promise<void> {
  const token = await getToken(db, mint);
  if (!token || token.status === "rejected_junk" || token.status === "archived") return;
  const snap = await loadMarket(db, mint, false);
  const rug = await safeRug(db, mint);
  const now = new Date();
  const patch = marketPatch(token, snap, rug, now, { keepPerformance: skipPerformance(token, null), stage: "t60" });
  const working = { ...token, ...patch, weakSince: patch.weakSince === undefined ? token.weakSince : patch.weakSince };
  let passed = true;
  let reason: string | null = null;
  if (token.status === "candidate") {
    const review = noteCandidate(token, snap, patch, now, true);
    if (review.demote) {
      patch.status = "archived";
      patch.archiveReason = review.reason;
      patch.archivedAt = now;
      passed = false;
      reason = review.reason;
    } else {
      const decision = decideT15({
        liqUsd: snap.liqUsd,
        volH1: snap.volH1,
        volM5: snap.volM5,
        t5VolM5: token.t5VolM5,
        buysM5: snap.buysM5,
        buyersEstimate: snap.buysM5,
        priceUsd: snap.priceUsd,
        mcapUsd: snap.mcapUsd,
        firstSeenPrice: token.firstSeenPriceUsd,
        firstSeenAt: token.firstSeenAt,
        now,
        alreadyWatching: false,
      });
      if (decision.promote) {
        patch.status = "watching";
        patch.promotionHits = decision.hits.join(",");
        await updateToken(db, mint, patch);
        if (!token.entryAt) await copyFirstAlertToEntry(db, mint);
        await maybeHold(db, token, now);
        await insertCheck(db, {
          mint,
          stage: "t60",
          passed: true,
          flags: { promoted: true, hits: decision.hits.join(",") },
          payload: { snap, score: patch.scoreBreakdown },
        });
        return;
      }
    }
  } else if (isLifeless(snap)) {
    patch.status = "archived";
    patch.archiveReason = "stale_1h";
    patch.archivedAt = now;
    passed = false;
    reason = "stale_1h";
  } else {
    const archive = decideArchive({
      status: token.status,
      now,
      weakSince: working.weakSince ?? null,
      liqUsd: snap.liqUsd,
      volH1: snap.volH1,
      entryAt: token.entryAt,
      gainPct: (patch.gainPct as number | null | undefined) ?? token.gainPct,
      buysM5: snap.buysM5,
      sellsM5: snap.sellsM5,
    });
    if (archive.archive && archive.reason) {
      patch.status = "archived";
      patch.archiveReason = archive.reason;
      patch.archivedAt = now;
      passed = false;
      reason = archive.reason;
    }
  }
  await updateToken(db, mint, patch);
  await maybeHold(db, token, now);
  await insertCheck(db, {
    mint,
    stage: "t60",
    passed,
    flags: { reason, lifeless: isLifeless(snap) },
    payload: { snap, score: patch.scoreBreakdown },
  });
}

async function maybeHold(db: AppDb, token: TokenRecord, now: Date): Promise<void> {
  if (!token.sniperWallet) return;
  if (token.holdCheckedAt && now.getTime() - token.holdCheckedAt.getTime() < 6 * HOUR) return;
  await enqueueJob(db, "hold_check", { mint: token.mint }, now);
}

async function runHold(db: AppDb, mint: string): Promise<void> {
  const token = await getToken(db, mint);
  if (!token?.sniperWallet || token.status === "rejected_junk") return;
  const balance = await tokenBalance(db, token.sniperWallet, mint);
  const now = new Date();
  const holding = balance > 0;
  const score = scoreToken({
    liqUsd: token.lastLiqUsd,
    volM5: token.lastVolM5,
    volH1: token.lastVolH1,
    buysM5: token.lastBuysM5,
    sellsM5: token.lastSellsM5,
    buysH1: token.lastBuysH1,
    sellsH1: token.lastSellsH1,
    topHolderPct: token.topHolderPct,
    mintRevoked: token.mintRevoked,
    freezeRevoked: token.freezeRevoked,
    rugcheckNormalised: token.rugcheckNormalised,
    sniperHolding: holding,
    entryAt: token.entryAt,
    now,
    venue: token.venue,
    graduated: token.graduated,
    lastPriceUsd: token.lastPriceUsd,
    athPriceUsd: token.athPriceUsd,
  });
  const published = publishReading({
    established: token.scoreBreakdown != null,
    current: token.score,
    pending: token.scorePending,
    next: score.total,
  });
  await updateToken(db, mint, {
    sniperStillHolding: holding,
    holdCheckedAt: now,
    score: published.value,
    scorePending: published.pending,
    scoreBreakdown:
      token.scoreBreakdown == null || published.pending == null ? { ...score, total: published.value } : token.scoreBreakdown,
  });
}

async function dispatch(db: AppDb, job: ClaimedJob): Promise<void> {
  const mint = typeof job.payload.mint === "string" ? job.payload.mint : "";
  const signature = typeof job.payload.signature === "string" ? job.payload.signature : "";
  const retry = job.payload.retry === true;
  switch (job.type) {
    case "parse":
      await runParse(db, signature);
      return;
    case "parse_rpc":
      await runParseRpc(db, signature);
      return;
    case "enrich_t0":
      await runT0(db, mint, retry);
      return;
    case "recheck_t5":
      await runT5(db, mint, retry);
      return;
    case "recheck_t15":
      await runT15(db, mint);
      return;
    case "recheck_t60":
      await runT60(db, mint);
      return;
    case "hold_check":
      await runHold(db, mint);
      return;
    default:
      throw new Error(`Unknown job ${job.type}`);
  }
}

function retryDelay(error: unknown, attempts: number): number | null {
  if (isVersionedTxError(error)) return 5_000;
  if (attempts >= 8) return null;
  if (error instanceof RateLimitError) return error.retryAfterMs;
  const base = Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
  return base + Math.floor(Math.random() * 1000);
}

export type TypeTally = {
  claimed: number;
  done: number;
  released: number;
  failed: number;
  pending: number;
};

export type QueueRun = {
  claimed: number;
  done: number;
  released: number;
  failed: number;
  pending: number;
  heldLease?: boolean;
  byType: Record<string, TypeTally>;
  gains?: { updated: number };
  archive?: { archived: number; revived: number; promoted: number };
};

export const QUEUE_RUN_BUDGET_MS = 45_000;
const CLAIM_HEADROOM_MS = 2_000;
const PARSE_CONCURRENCY = 4;

export function queueBudgetMs(elapsedMs: number, cap = QUEUE_RUN_BUDGET_MS): number {
  return Math.max(0, cap - Math.max(0, elapsedMs));
}

function blankTally(): TypeTally {
  return { claimed: 0, done: 0, released: 0, failed: 0, pending: 0 };
}

async function withPending(db: AppDb, byType: Record<string, TypeTally>): Promise<Record<string, TypeTally>> {
  const pending = await pendingCountsByType(db);
  const next = { ...byType };
  for (const [type, count] of Object.entries(pending)) {
    next[type] = { ...(next[type] ?? blankTally()), pending: count };
  }
  for (const tally of Object.values(next)) {
    if (tally.pending == null) tally.pending = 0;
  }
  return next;
}

async function emptyQueueRun(db: AppDb): Promise<QueueRun> {
  const byType = await withPending(db, {});
  const pending = await countPendingJobs(db);
  return { claimed: 0, done: 0, released: 0, failed: 0, pending, byType };
}

async function runClaimed(
  db: AppDb,
  jobs: ClaimedJob[],
  deadline: number,
): Promise<{ done: number; released: number; failed: number; rpcBlocked: boolean; byType: Record<string, TypeTally> }> {
  const handled = new Set<number>();
  const byType: Record<string, TypeTally> = {};
  const tally = (type: string, field: keyof Omit<TypeTally, "pending">) => {
    const row = byType[type] ?? blankTally();
    row[field] += 1;
    byType[type] = row;
  };
  let cursor = 0;
  let stop = false;
  let rpcBlocked = false;
  let loggedThrottle = false;
  let done = 0;
  let released = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (!stop && Date.now() < deadline) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      const job = jobs[index]!;
      handled.add(job.id);
      tally(job.type, "claimed");
      try {
        await dispatch(db, job);
        await finishJob(db, job.id);
        tally(job.type, "done");
        done += 1;
      } catch (error) {
        if (error instanceof RateLimitError) {
          const retryAt = new Date(Date.now() + Math.max(0, error.retryAfterMs));
          await deferJob(db, job.id, retryAt);
          tally(job.type, "released");
          released += 1;
          if ((error.provider === "rpc" || error.provider === "helius") && error.retryAfterMs >= 2_000) {
            stop = true;
            rpcBlocked = true;
          }
          if (!loggedThrottle) {
            loggedThrottle = true;
            console.warn(`[keel] ${error.provider} throttled (${error.reason}); returned remaining jobs to the queue`);
          }
          continue;
        }
        const message = redactSecrets(error instanceof Error ? error.message : "job failed");
        const delay = retryDelay(error, job.attempts);
        await failJob(db, job.id, job.attempts, message, delay == null ? null : new Date(Date.now() + delay));
        tally(job.type, "failed");
        failed += 1;
        console.warn(`[keel] job ${job.type} failed`, message);
      }
    }
  }

  const workers = Math.min(PARSE_CONCURRENCY, Math.max(1, jobs.length));
  try {
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    const deferUntil = stop ? new Date(Date.now() + 15_000) : null;
    for (const job of jobs) {
      if (handled.has(job.id)) continue;
      if (deferUntil) await deferJob(db, job.id, deferUntil);
      else await releaseJob(db, job.id);
      tally(job.type, "released");
      released += 1;
    }
  }
  return { done, released, failed, rpcBlocked, byType };
}

export async function processQueue(db: AppDb, limit = 12, budgetMs = 8_000): Promise<QueueRun> {
  if (budgetMs <= 0 || limit <= 0) return emptyQueueRun(db);
  const deadline = Date.now() + budgetMs;
  let claimed = 0;
  let done = 0;
  let released = 0;
  let failed = 0;
  const byType: Record<string, TypeTally> = {};
  await sweepStaleJobs(db);
  await requeueVersionedParseFailures(db);
  await backfillOrphanMints(db, 40);
  while (Date.now() + CLAIM_HEADROOM_MS < deadline) {
    const jobs = await claimJobs(db, limit);
    if (jobs.length === 0) break;
    claimed += jobs.length;
    const batch = await runClaimed(db, jobs, deadline);
    await flushAlerts(db, deadline);
    done += batch.done;
    released += batch.released;
    failed += batch.failed;
    for (const [type, tally] of Object.entries(batch.byType)) {
      const row = byType[type] ?? blankTally();
      row.claimed += tally.claimed;
      row.done += tally.done;
      row.released += tally.released;
      row.failed += tally.failed;
      byType[type] = row;
    }
    if (batch.rpcBlocked) break;
  }
  return {
    claimed,
    done,
    released,
    failed,
    pending: await countPendingJobs(db),
    byType: await withPending(db, byType),
  };
}

export async function drainQueue(db: AppDb, startedAt = Date.now()): Promise<QueueRun> {
  const deadline = startedAt + QUEUE_RUN_BUDGET_MS;
  const queue = await processQueue(db, 12, Math.max(0, deadline - Date.now()));
  if (Date.now() + 1_500 < deadline) {
    try {
      queue.gains = await refreshGains(db, { limit: 200, deadline });
      await flushAlerts(db, deadline);
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      queue.gains = { updated: 0 };
    }
  }
  if (Date.now() + 1_500 < deadline) {
    queue.archive = await runArchiveAndRevive(db, { deadline, dueLimit: 8, reviveLimit: 8 });
  }
  return queue;
}

export type CronRoute = "poll" | "recheck" | "gains" | "archive";

export async function runCron(db: AppDb, route: CronRoute) {
  await markPipelineRun(db, route, "start");
  const started = Date.now();
  const holder = `${route}:${crypto.randomUUID()}`;
  const held = await tryDrainLease(db, holder);
  if (!held) {
    const queue = await emptyQueueRun(db);
    queue.heldLease = false;
    await markPipelineRun(db, route, "finish");
    return { route, heldLease: false, polled: null, queue };
  }
  try {
    if (route === "recheck") {
      const queue = await runRecheck(db, started);
      queue.heldLease = true;
      return { route, heldLease: true, polled: null, queue };
    }
    const polled =
      route === "poll" ? await pollWallets(db, 2, { deadline: started + QUEUE_RUN_BUDGET_MS }) : null;
    const queue = await drainQueue(db, started);
    queue.heldLease = true;
    return { route, heldLease: true, polled, queue };
  } finally {
    await releaseDrainLease(db, holder);
    await markPipelineRun(db, route, "finish");
  }
}

const RECHECK_QUEUE_BUDGET_MS = 35_000;
const RECHECK_DEADLINE_MS = 50_000;

/**
 * Recheck stays inside 50s: priority drain first (capped at 35s), then the shadow
 * verdict batch only with the time left. Each model attempt is capped at 15s and
 * by that same deadline. At most two judgements.
 */
export async function runRecheck(
  db: AppDb,
  startedAt = Date.now(),
): Promise<QueueRun & { aiStored: number; aiSkipped: number; aiAttempted: number }> {
  const deadlineMs = startedAt + RECHECK_DEADLINE_MS;
  const queueBudget = Math.max(0, Math.min(RECHECK_QUEUE_BUDGET_MS, deadlineMs - Date.now()));
  const queue = await processQueue(db, 12, queueBudget);
  if (Date.now() >= deadlineMs) return { ...queue, aiStored: 0, aiSkipped: 0, aiAttempted: 0 };
  try {
    const batch = await runShadowVerdictBatch(db, { deadlineMs, limit: 2 });
    return { ...queue, aiStored: batch.stored, aiSkipped: batch.skipped, aiAttempted: batch.attempted };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    console.warn(`[keel] ai verdict batch failed ${message.replace(/[A-Za-z0-9_-]{30,}/g, "[redacted]").slice(0, 160)}`);
    return { ...queue, aiStored: 0, aiSkipped: 0, aiAttempted: 0 };
  }
}

export async function applyRefresh(db: AppDb, mint: string, snap: MarketSnapshot, stage: string, targetAt: Date | null = null): Promise<void> {
  const token = await getToken(db, mint);
  if (!token) return;
  const now = new Date();
  const rug = ["gain_refresh","delivery_refresh","hourly"].includes(stage) ? null : await safeRug(db, mint);
  const patch = marketPatch(token, snap, rug, now, { keepPerformance: skipPerformance(token, null) });
  if (!token.entryAt && !token.firstAlertAt) {
    delete patch.gainPct;
    delete patch.gainBasis;
    delete patch.athPriceUsd;
    delete patch.athMcapUsd;
    delete patch.athGainPct;
    delete patch.athAt;
  }
  await persistMarketCheck(db, mint, patch, {
    mint,
    stage,
    passed: true,
    flags: { liqUsd: snap.liqUsd, volH1: snap.volH1, priceUsd: snap.priceUsd },
    payload: { snap, score: patch.scoreBreakdown, targetAt },
  });
}

export async function refreshGains(
  db: AppDb,
  options?: { limit?: number; deadline?: number },
): Promise<{ updated: number; error?: string }> {
  // Reserve time for the provider's inline wait + 8s request timeout and writes.
  const deadline = options?.deadline ?? Date.now() + 30_000;
  const canFetch = () => Date.now() + 12_000 < deadline;
  if (!canFetch()) return { updated: 0 };
  // Select once: an unsuccessful oldest token must not monopolise this run.
  const mints = await gainRefreshMints(db, options?.limit ?? 200);
  let updated = 0;
  let jupiterAvailable = true;
  for (let index = 0; index < mints.length && canFetch(); index += 30) {
    const batchMints = mints.slice(index, index + 30);
    const snaps = new Map<string, MarketSnapshot>();
    let dexLimited = false;
    let dexError: unknown;
    try {
      const batch = await getDexSnapshots(db, batchMints);
      for (const [mint, snap] of batch) snaps.set(mint, snap);
    } catch (error) {
      dexError = error;
      dexLimited = error instanceof RateLimitError;
      if (!dexLimited && !jupiterAvailable) throw error;
    }
    // Jupiter is supplementary: a failure must not discard good Dex data.
    if (jupiterAvailable && canFetch()) {
      try {
        const fallbackMints = batchMints.filter(mint => positive(snaps.get(mint)?.priceUsd) == null && positive(snaps.get(mint)?.mcapUsd) == null);
        const prices = fallbackMints.length ? await getJupiterPrices(db, fallbackMints) : new Map();
        for (const [mint, price] of prices) {
          const snap = { ...emptySnapshot("jupiter"), observedAt: price.observedAt };
          snaps.set(mint, { ...snap, priceUsd: price.priceUsd, liqUsd: snap.liqUsd ?? price.liquidity });
        }
      } catch {
        jupiterAvailable = false;
      }
    }
    if (snaps.size === 0 && dexError && !dexLimited) throw dexError;
    // Persist each batch before fetching another; don't accumulate a run's writes
    // after its time budget has expired. Provider gates continue to enforce quotas.
    for (const mint of batchMints) {
      if (Date.now() + 1_000 >= deadline) break;
      const snap = snaps.get(mint);
      // An empty response is not a successful market observation.
      if (!snap || (positive(snap.priceUsd) == null && positive(snap.mcapUsd) == null)) {
        await insertCheck(db,{mint,stage:"gain_refresh_unavailable",passed:false,flags:{missingQuote:true},payload:{snap:emptySnapshot("unavailable")}});
        continue;
      }
      await applyRefresh(db, mint, snap, "gain_refresh");
      updated += 1;
    }
    await flushAlerts(db, deadline);
    if (dexLimited) break;
  }
  return { updated };
}

export async function runArchiveAndRevive(
  db: AppDb,
  options?: { deadline?: number; dueLimit?: number; reviveLimit?: number },
): Promise<{ archived: number; revived: number; promoted: number }> {
  let archived = 0;
  let revived = 0;
  let promoted = 0;
  const due = await archiveCandidates(db, options?.dueLimit ?? 40);
  for (const mint of due) {
    if (options?.deadline != null && Date.now() + 1_000 > options.deadline) break;
    const token = await getToken(db, mint);
    if (!token) continue;
    let snap: MarketSnapshot;
    try {
      snap = await loadMarket(db, mint, false);
    } catch (error) {
      if (error instanceof RateLimitError) break;
      continue;
    }
    const now = new Date();
    const patch = marketPatch(token, snap, null, now, { keepPerformance: skipPerformance(token, null) });
    if (token.status === "candidate") {
      const review = noteCandidate(token, snap, patch, now, true);
      if (review.demote) {
        patch.status = "archived";
        patch.archiveReason = review.reason;
        patch.archivedAt = now;
        archived += 1;
      } else {
        const decision = decideT15({
          liqUsd: snap.liqUsd,
          volH1: snap.volH1,
          volM5: snap.volM5,
          t5VolM5: token.t5VolM5,
          buysM5: snap.buysM5,
          buyersEstimate: snap.buysM5,
          priceUsd: snap.priceUsd,
          mcapUsd: snap.mcapUsd,
          firstSeenPrice: token.firstSeenPriceUsd,
          firstSeenAt: token.firstSeenAt,
          now,
          alreadyWatching: false,
        });
        if (decision.promote) {
          patch.status = "watching";
          patch.promotionHits = decision.hits.join(",");
          promoted += 1;
        }
      }
    } else {
      const weakSince = patch.weakSince === undefined ? token.weakSince : patch.weakSince;
      const gainPct = (patch.gainPct as number | null | undefined) ?? token.gainPct;
      const lifeless =
        token.firstSeenAt != null &&
        now.getTime() - token.firstSeenAt.getTime() >= HOUR &&
        isLifeless(snap);
      const archive = decideArchive({
        status: token.status,
        now,
        weakSince: weakSince ?? null,
        liqUsd: snap.liqUsd,
        volH1: snap.volH1,
        entryAt: token.entryAt,
        gainPct,
        buysM5: snap.buysM5,
        sellsM5: snap.sellsM5,
      });
      if (lifeless || archive.archive) {
        patch.status = "archived";
        patch.archiveReason = lifeless ? "stale_1h" : archive.reason;
        patch.archivedAt = now;
        archived += 1;
      }
    }
    const copyEntry = patch.status === "watching" && token.status !== "watching" && !token.entryAt;
    await updateToken(db, mint, patch);
    if (copyEntry) await copyFirstAlertToEntry(db, mint);
  }

  const archivedMints = await reviveCandidates(db, options?.reviveLimit ?? 30);
  for (const mint of archivedMints) {
    if (options?.deadline != null && Date.now() + 1_000 > options.deadline) break;
    const token = await getToken(db, mint);
    if (!token || token.status !== "archived") continue;
    let snap: MarketSnapshot;
    try {
      snap = await loadMarket(db, mint, false);
    } catch (error) {
      if (error instanceof RateLimitError) break;
      continue;
    }
    if (!shouldRevive(snap.volH1, snap.liqUsd)) {
      await updateToken(db, mint, {
        lastCheckedAt: new Date(),
        lastLiqUsd: snap.liqUsd,
        lastVolH1: snap.volH1,
        lastPriceUsd: snap.priceUsd,
        ...missingMetadata(token, snap),
      });
      continue;
    }
    const now = new Date();
    await updateToken(db, mint, {
      status: "watching",
      reviveCount: token.reviveCount + 1,
      revivedAt: now,
      lastCheckedAt: now,
      lastPriceUsd: snap.priceUsd,
      lastMcapUsd: snap.mcapUsd,
      lastLiqUsd: snap.liqUsd,
      lastVolH1: snap.volH1,
      lastVolM5: snap.volM5,
      ...missingMetadata(token, snap),
    });
    if (!token.entryAt) await copyFirstAlertToEntry(db, mint);
    await insertCheck(db, {
      mint,
      stage: "revive",
      passed: true,
      flags: { volH1: snap.volH1, liqUsd: snap.liqUsd, entryReset: false },
      payload: snap,
    });
    revived += 1;
  }
  await pruneStorage(db);
  return { archived, revived, promoted };
}

export async function archiveToken(db: AppDb, mint: string): Promise<TokenRecord | null> {
  const token = await getToken(db, mint);
  if (!token) return null;
  if (token.status === "rejected_junk") return token;
  const now = new Date();
  await updateToken(db, mint, { status: "archived", archiveReason: "manual", archivedAt: now });
  await insertCheck(db, { mint, stage: "archive", passed: true, flags: { reason: "manual" }, payload: null });
  return getToken(db, mint);
}

export async function reviveToken(db: AppDb, mint: string): Promise<TokenRecord | null> {
  const token = await getToken(db, mint);
  if (!token || token.status !== "archived") return token;
  let snap = emptySnapshot();
  try {
    snap = await loadMarket(db, mint, false);
  } catch (error) {
    if (!(error instanceof RateLimitError)) console.warn("[keel] revive market fetch failed", error);
  }
  const now = new Date();
  const patch = marketPatch(token, snap.pairCount > 0 ? snap : { ...snap, priceUsd: token.lastPriceUsd, mcapUsd: token.lastMcapUsd, liqUsd: token.lastLiqUsd, volH1: token.lastVolH1, volM5: token.lastVolM5, buysM5: token.lastBuysM5, sellsM5: token.lastSellsM5, buysH1: token.lastBuysH1, sellsH1: token.lastSellsH1 }, null, now, {
    keepPerformance: skipPerformance(token, null),
  });
  patch.status = "watching";
  patch.reviveCount = token.reviveCount + 1;
  patch.revivedAt = now;
  if (!token.entryAt && !token.firstAlertAt) {
    delete patch.gainPct;
    delete patch.gainBasis;
    delete patch.athPriceUsd;
    delete patch.athMcapUsd;
    delete patch.athGainPct;
    delete patch.athAt;
  }
  await updateToken(db, mint, patch);
  if (!token.entryAt) await copyFirstAlertToEntry(db, mint);
  await insertCheck(db, {
    mint,
    stage: "revive",
    passed: true,
    flags: { manual: true, entryReset: false },
    payload: { entryAt: token.entryAt },
  });
  return getToken(db, mint);
}

const SIGNATURE_PAGE = 40;
const MAX_SIGNATURE_PAGES = 8;

type SignatureRow = { signature: string; slot?: number; blockTime?: number | null; err?: unknown };

async function walkSignatures(
  db: AppDb,
  address: string,
  until: string | null,
  before: string | null,
  deadline?: number,
): Promise<{ rows: SignatureRow[]; exhausted: boolean; newest: string | null; oldest: string | null; blocked: boolean }> {
  const rows: SignatureRow[] = [];
  let cursor = before;
  let newest: string | null = null;
  let oldest: string | null = null;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    if (deadline != null && Date.now() + 4_000 > deadline) return { rows, exhausted: false, newest, oldest, blocked: false };
    let batch: SignatureRow[];
    try {
      batch = await getSignatures(db, address, until, cursor);
    } catch (error) {
      if (error instanceof RateLimitError) return { rows, exhausted: false, newest, oldest, blocked: true };
      throw error;
    }
    if (batch.length === 0) return { rows, exhausted: true, newest, oldest, blocked: false };
    if (!newest) newest = batch[0]?.signature ?? null;
    rows.push(...batch);
    oldest = batch[batch.length - 1]?.signature ?? oldest;
    cursor = oldest;
    if (batch.length < SIGNATURE_PAGE) return { rows, exhausted: true, newest, oldest, blocked: false };
  }
  return { rows, exhausted: false, newest, oldest, blocked: false };
}

async function storePolledSignatures(db: AppDb, wallet: string, rows: SignatureRow[]): Promise<{ signatures: number; queued: number }> {
  let signatures = 0;
  let queued = 0;
  const fresh = newSignatures([], rows.map((row) => row.signature));
  for (const row of rows) {
    if (!fresh.includes(row.signature)) continue;
    const err = Boolean(row.err);
    const inserted = await insertRawEvent(db, {
      signature: row.signature,
      slot: row.slot ?? null,
      blockTime: row.blockTime ? new Date(row.blockTime * 1000) : null,
      err,
      programs: [],
      source: null,
      wallet,
      mint: null,
      side: "unknown",
      solDelta: null,
      tokenDelta: null,
      decimals: null,
      venue: { venue: null, graduated: false },
      raw: { polled: true, err: row.err ?? null },
    });
    if (!inserted) continue;
    signatures += 1;
    if (!err) {
      await enqueueJob(db, "parse_rpc", { signature: row.signature }, new Date());
      queued += 1;
    }
  }
  return { signatures, queued };
}

export async function pollWallets(
  db: AppDb,
  walletLimit = 4,
  options?: { deadline?: number },
): Promise<{ wallets: number; signatures: number; queued: number }> {
  const rows = await enabledWallets(db, walletLimit);
  let signatures = 0;
  let queued = 0;
  for (const wallet of rows) {
    try {
      const until = wallet.last_signature;
      let resume = wallet.resume_before;
      if (resume) {
        const gap = await walkSignatures(db, wallet.address, until, resume, options?.deadline);
        const stored = await storePolledSignatures(db, wallet.address, gap.rows);
        signatures += stored.signatures;
        queued += stored.queued;
        if (!gap.exhausted) {
          const checkpoint = planSignatureCheckpoint({
            previousCursor: until,
            newest: null,
            oldest: gap.oldest ?? resume,
            exhausted: false,
          });
          await markWalletPolled(db, wallet.address, checkpoint.lastSignature === until ? null : checkpoint.lastSignature, checkpoint.resumeBefore);
          if (gap.blocked) break;
          continue;
        }
        resume = null;
        await markWalletPolled(db, wallet.address, null, null);
        if (gap.blocked) break;
      }
      const tip = await walkSignatures(db, wallet.address, until, null, options?.deadline);
      const stored = await storePolledSignatures(db, wallet.address, tip.rows);
      signatures += stored.signatures;
      queued += stored.queued;
      const checkpoint = planSignatureCheckpoint({
        previousCursor: until,
        newest: tip.newest,
        oldest: tip.oldest,
        exhausted: tip.exhausted,
      });
      const advance = tip.exhausted ? checkpoint.lastSignature : null;
      await markWalletPolled(db, wallet.address, advance, checkpoint.resumeBefore);
      if (tip.blocked) break;
    } catch (error) {
      await markWalletPolled(db, wallet.address, null, wallet.resume_before);
      if (error instanceof RateLimitError) break;
      console.warn(`[keel] poll failed for ${wallet.address}`, redactSecrets(error instanceof Error ? error.message : "poll failed"));
    }
  }
  return { wallets: rows.length, signatures, queued };
}
