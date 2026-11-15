import { sql } from "drizzle-orm";
import { resolveGain, performanceAnchor } from "@/lib/logic/gains";
import { asRows } from "@/lib/db/rows";
import type { AiShadowVerdict } from "@/lib/ai/types";
import { budgetPerMinute, type ProviderName } from "@/lib/budgets";
import type { AppDb } from "@/lib/db/index";
import { unknownEventCounts, type TokenRecord } from "@/lib/db/repo";
import { asDate, asJson, asNumber } from "@/lib/db/rows";
import type { AiVerdictRecord } from "@/lib/db/verdicts";
import { blankToNull, httpsUrl } from "@/lib/logic/metadata";
import {
  FLAG_CODES,
  MISSING_LABELS,
  buildDataQuality,
  emptyFlagCounts,
  emptyLabelCounts,
} from "@/lib/logic/quality";
import { jobPriority } from "@/lib/logic/queue";
import { INTERESTING_SCORE, type ScoreBreakdown } from "@/lib/logic/score";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function presentAiVerdict(verdict: AiVerdictRecord): AiShadowVerdict {
  return {
    verdict: verdict.verdict,
    conviction: verdict.conviction,
    bullPoints: verdict.bullPoints,
    redFlags: verdict.redFlags,
    narrative: verdict.narrative,
    invalidation: verdict.invalidation,
    holderSummary: verdict.holderSummary,
    reasoning: verdict.reasoning,
    unavailableReason: verdict.unavailableReason,
    model: verdict.model,
    createdAt: verdict.createdAt.toISOString(),
    stage: verdict.stage,
    promptTokens: verdict.promptTokens,
    completionTokens: verdict.completionTokens,
    costUsd: verdict.costUsd,
    theses: verdict.theses,
  };
}

export function presentToken(token: TokenRecord, verdict: AiVerdictRecord | null = null, unknownEvents = 0) {
  return {
    mint: token.mint,
    symbol: blankToNull(token.symbol),
    name: blankToNull(token.name),
    imageUrl: httpsUrl(token.imageUrl),
    decimals: token.decimals,
    status: token.status,
    score: token.score,
    interesting: token.score >= INTERESTING_SCORE,
    scoreBreakdown: token.scoreBreakdown,
    venue: token.venue,
    graduated: token.graduated,
    firstSeenAt: iso(token.firstSeenAt),
    firstSeenPriceUsd: token.firstSeenPriceUsd,
    firstSeenMcapUsd: token.firstSeenMcapUsd,
    sniperBuyPriceUsd: token.sniperBuyPriceUsd,
    sniperBuyMcapUsd: token.sniperBuyMcapUsd,
    sniperBuySol: token.sniperBuySol,
    sniperBuyTx: token.sniperBuyTx,
    sniperBuyAt: iso(token.sniperBuyAt),
    sniperWallet: token.sniperWallet,
    sniperStillHolding: token.sniperStillHolding,
    entryAt: iso(token.entryAt),
    entryPriceUsd: token.entryPriceUsd,
    entryMcapUsd: token.entryMcapUsd,
    lastPriceUsd: token.lastPriceUsd,
    lastMcapUsd: token.lastMcapUsd,
    lastLiqUsd: token.lastLiqUsd,
    lastVolM5: token.lastVolM5,
    lastVolH1: token.lastVolH1,
    lastBuysM5: token.lastBuysM5,
    lastSellsM5: token.lastSellsM5,
    gainPct: token.gainPct,
    gainBasis: token.gainBasis,
    athPriceUsd: token.athPriceUsd,
    athMcapUsd: token.athMcapUsd,
    athGainPct: token.athGainPct,
    athAt: iso(token.athAt),
    archiveReason: token.archiveReason,
    archivedAt: iso(token.archivedAt),
    reviveCount: token.reviveCount,
    revivedAt: iso(token.revivedAt),
    pairCount: token.pairCount,
    lastCheckedAt: iso(token.lastCheckedAt),
    quoteSource: null as string | null,
    ageAnchor: iso(token.entryAt ?? token.firstAlertAt ?? token.firstSeenAt),
    firstAlertAt: iso(token.firstAlertAt),
    firstAlertPriceUsd: token.firstAlertPriceUsd,
    firstAlertMcapUsd: token.firstAlertMcapUsd,
    confidence: token.confidence,
    confidenceReasons: token.confidenceReasons,
    capRegime: token.capRegime,
    alertPath: token.alertPath,
    socials: token.socials,
    mintRevoked: token.mintRevoked,
    freezeRevoked: token.freezeRevoked,
    topHolderPct: token.topHolderPct,
    rugcheckNormalised: token.rugcheckNormalised,
    dataQuality: buildDataQuality({ ...token, unknownEvents }),
    aiVerdict: verdict ? presentAiVerdict(verdict) : null,
  };
}

export async function presentStoredTokens(
  db: AppDb,
  tokens: TokenRecord[],
  verdicts?: { get(mint: string): AiVerdictRecord | null | undefined },
) {
  if (!tokens.length) return [];
  const mints = tokens.map(token => token.mint);
  // Indexed lateral lookup selects one complete market observation per token.
  // Never combine an old field with a newer snapshot or pull AI/source JSON into list responses.
  const [counts, result] = await Promise.all([
    unknownEventCounts(db, mints),
    db.execute(sql`SELECT t.mint,c.checked_at,c.market FROM tokens t
      LEFT JOIN LATERAL (
        SELECT checked_at,jsonb_build_object(
          'priceUsd',coalesce(payload->'snap',payload)->'priceUsd',
          'mcapUsd',coalesce(payload->'snap',payload)->'mcapUsd',
          'liqUsd',coalesce(payload->'snap',payload)->'liqUsd',
          'volM5',coalesce(payload->'snap',payload)->'volM5',
          'volH1',coalesce(payload->'snap',payload)->'volH1',
          'buysM5',coalesce(payload->'snap',payload)->'buysM5',
          'sellsM5',coalesce(payload->'snap',payload)->'sellsM5',
          'source',coalesce(payload->'snap',payload)->'source',
          'observedAt',coalesce(payload->'snap',payload)->'observedAt') AS market
        FROM token_checks WHERE mint=t.mint AND
          (coalesce(payload->'snap',payload) ? 'priceUsd' OR coalesce(payload->'snap',payload) ? 'mcapUsd')
        ORDER BY checked_at DESC,id DESC LIMIT 1
      ) c ON true WHERE t.mint IN (${sql.join(mints.map(m => sql`${m}`),sql`,`)})`),
  ]);
  const quotes = new Map(asRows<{mint:string;checked_at:unknown;market:unknown}>(result).map(row => [row.mint,row]));
  return tokens.map(token => {
    const quote = quotes.get(token.mint);
    const market = asJson<Record<string,unknown>>(quote?.market);
    const at = asDate(market?.observedAt ?? quote?.checked_at);
    const current = { ...token,
      lastPriceUsd: asNumber(market?.priceUsd), lastMcapUsd: asNumber(market?.mcapUsd),
      lastLiqUsd: asNumber(market?.liqUsd), lastVolM5: asNumber(market?.volM5), lastVolH1: asNumber(market?.volH1),
      lastBuysM5: asNumber(market?.buysM5), lastSellsM5: asNumber(market?.sellsM5), lastCheckedAt:at,
    };
    const anchor = performanceAnchor(token);
    const gain = resolveGain({lastPrice:current.lastPriceUsd,lastMcap:current.lastMcapUsd,entryPrice:anchor?.priceUsd ?? null,entryMcap:anchor?.mcapUsd ?? null});
    const presented = presentToken({...current,gainPct:gain.gainPct,gainBasis:gain.basis},verdicts?.get(token.mint) ?? null,counts.get(token.mint) ?? 0);
    return {...presented,quoteSource: typeof market?.source === 'string' ? market.source : null};
  });
}

export type TokenDto = ReturnType<typeof presentToken>;

export function presentCheck(row: {
  id: number | string;
  checked_at: Date | string;
  stage: string;
  passed: boolean | null;
  flags: unknown;
  payload: unknown;
}) {
  return {
    id: Number(row.id),
    checkedAt: asDate(row.checked_at)?.toISOString() ?? null,
    stage: row.stage,
    passed: row.passed,
    flags: asJson<Record<string, unknown>>(row.flags),
    payload: asJson<Record<string, unknown>>(row.payload),
  };
}

export function presentWallet(row: Record<string, unknown>) {
  const events1h = asNumber(row.events_1h) ?? 0;
  const events24h = asNumber(row.events_24h) ?? 0;
  return {
    address: String(row.address),
    label: String(row.label ?? ""),
    enabled: Boolean(row.enabled),
    createdAt: asDate(row.created_at)?.toISOString() ?? null,
    lastIngestAt: asDate(row.last_ingest_at)?.toISOString() ?? null,
    lastPolledAt: asDate(row.last_polled_at)?.toISOString() ?? null,
    events1h,
    events24h,
    dailyRate: events1h > 0 ? events1h * 24 : events24h,
  };
}

export function presentBuy(row: Record<string, unknown>) {
  return {
    signature: String(row.signature),
    wallet: String(row.wallet),
    walletLabel: (row.wallet_label as string | null) ?? null,
    mint: (row.mint as string | null) ?? null,
    symbol: blankToNull(row.symbol as string | null),
    name: blankToNull(row.name as string | null),
    imageUrl: httpsUrl(row.image_url),
    venue: (row.venue as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    side: String(row.side),
    solDelta: asNumber(row.sol_delta),
    tokenDelta: asNumber(row.token_delta),
    blockTime: asDate(row.block_time)?.toISOString() ?? null,
    ingestedAt: asDate(row.ingested_at)?.toISOString() ?? null,
    entryAt: asDate(row.entry_at)?.toISOString() ?? null,
    entryPriceUsd: asNumber(row.entry_price_usd),
    entryMcapUsd: asNumber(row.entry_mcap_usd),
    lastPriceUsd: asNumber(row.last_price_usd),
    lastMcapUsd: asNumber(row.last_mcap_usd),
    programs: Array.isArray(row.programs) ? row.programs : [],
  };
}

const PROVIDERS: ProviderName[] = ["dexscreener", "jupiter", "rugcheck", "geckoterminal", "rpc", "helius", "pump", "gmgn"];

export function presentStats(stats: {
  queues: { status: string; n: number }[];
  types: { type: string; n: number }[];
  depths?: { type: string; status: string; n: number }[];
  tokenCounts: { status: string; n: number }[];
  usage: { provider: string; n: number }[];
  throttles: { provider: string; at: string | Date | null }[];
  lastIngestAt: Date | null;
  runs?: { route: string; started_at: string | Date | null; finished_at: string | Date | null }[];
  quality?: Record<string, unknown>;
}) {
  const queue: Record<string, number> = {};
  for (const row of stats.queues) queue[row.status] = Number(row.n);
  const pendingByType: Record<string, number> = {};
  for (const row of stats.types) pendingByType[row.type] = Number(row.n);
  const tokens: Record<string, number> = {};
  for (const row of stats.tokenCounts) tokens[row.status] = Number(row.n);
  const used = new Map(stats.usage.map((row) => [row.provider, Number(row.n)]));
  const throttled = new Map(stats.throttles.map((row) => [row.provider, asDate(row.at)?.toISOString() ?? null]));
  const depthByType: Record<string, { pending: number; running: number; failed: number }> = {};
  for (const row of stats.depths ?? []) {
    const bucket = depthByType[row.type] ?? { pending: 0, running: 0, failed: 0 };
    if (row.status === "pending" || row.status === "running" || row.status === "failed") {
      bucket[row.status] = Number(row.n);
    }
    depthByType[row.type] = bucket;
  }
  const missing = emptyLabelCounts();
  const flags = emptyFlagCounts();
  for (const label of MISSING_LABELS) missing[label] = Number(stats.quality?.[label] ?? 0);
  for (const flag of FLAG_CODES) flags[flag] = Number(stats.quality?.[flag] ?? 0);
  return {
    queue,
    pendingByType,
    depthByType: Object.fromEntries(
      Object.entries(depthByType).sort(([left], [right]) => jobPriority(left) - jobPriority(right) || left.localeCompare(right)),
    ),
    runs: (stats.runs ?? []).map((run) => ({
      route: run.route,
      startedAt: asDate(run.started_at)?.toISOString() ?? null,
      finishedAt: asDate(run.finished_at)?.toISOString() ?? null,
    })),
    dataQuality: { missing, flags },
    tokens,
    lastIngestAt: stats.lastIngestAt?.toISOString() ?? null,
    providers: PROVIDERS.map((provider) => ({
      provider,
      usedLastMinute: used.get(provider) ?? 0,
      budgetPerMinute: budgetPerMinute(provider),
      last429At: throttled.get(provider) ?? null,
    })),
  };
}

export function emptyBreakdown(): ScoreBreakdown {
  return {
    base: 50,
    liquidity: 0,
    volume: 0,
    buyPressure: 0,
    holders: 0,
    authorities: 0,
    rugcheck: 0,
    sniperHold: 0,
    age: 0,
    venue: 0,
    drawdown: 0,
    total: 50,
  };
}
