import type { AppDb } from "@/lib/db/index";
import {
  countGateCalls,
  noteProviderBackoff,
  readCache,
  recordProviderCall,
  reserveProviderSlot,
  writeCache,
} from "@/lib/db/repo";
import {
  PARSED_TX_CONFIG,
  PARSED_TX_METHOD_CONFIG,
  budgetPerMinute,
  exceedsProviderBudget,
  minGapMs,
  providerGate,
  rpcUrl,
  type ProviderName,
} from "@/lib/budgets";
import type { MarketSnapshot } from "@/lib/logic/funnel";
import {
  mergeMeta,
  parseGmgnToken,
  parsePumpCoin,
  tradeFromRows,
  type ExternalTrade,
  type PublicTokenMeta,
} from "@/lib/logic/external";
import type { HeliusLike } from "@/lib/logic/parse";
import { emptySocials, hasStoredSocials, type TokenSocials } from "@/lib/logic/quality";
import { blankToNull, httpsUrl } from "@/lib/logic/metadata";
import { asNumber } from "@/lib/db/rows";

export type RateLimitReason = "budget" | "pace" | "http";

export class RateLimitError extends Error {
  readonly provider: string;
  readonly retryAfterMs: number;
  readonly reason: RateLimitReason;

  constructor(provider: string, retryAfterMs: number, reason: RateLimitReason = "budget") {
    super(`${provider} is over the free-tier budget`);
    this.name = "RateLimitError";
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
  }
}

const memory = new Map<string, { at: number; value: unknown }>();
const providerTail = new Map<string, Promise<void>>();
const inFlight = new Map<string, number>();

const MAX_INLINE_WAIT_MS = 3_000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueProvider<T>(provider: string, task: () => Promise<T>): Promise<T> {
  const previous = providerTail.get(provider) ?? Promise.resolve();
  const run = previous.then(task, task);
  providerTail.set(
    provider,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function resetProviderGatesForTests(): void {
  providerTail.clear();
  inFlight.clear();
}

export function redactSecrets(message: string): string {
  return message.replace(/api-key=[^&\s"']+/gi, "api-key=redacted").slice(0, 500);
}

export function emptySnapshot(source = "none"): MarketSnapshot {
  return {
    priceUsd: null,
    mcapUsd: null,
    liqUsd: null,
    volM5: null,
    volH1: null,
    volH6: null,
    volH24: null,
    buysM5: null,
    sellsM5: null,
    buysH1: null,
    sellsH1: null,
    pairCount: 0,
    symbol: null,
    name: null,
    imageUrl: null,
    dexId: null,
    source,
    socials: null,
  };
}

export type PairDisplay = {
  volH1: number | null;
  volH6: number | null;
  volH24: number | null;
  socials: TokenSocials | null;
};

/** Read display windows and socials off a cached Dex snapshot. Missing keys stay null. */
export function pairDisplay(snap: Partial<MarketSnapshot> | undefined): PairDisplay {
  return {
    volH1: snap?.volH1 ?? null,
    volH6: snap?.volH6 ?? null,
    volH24: snap?.volH24 ?? null,
    socials: snap?.socials ?? null,
  };
}

function remember<T>(key: string, value: T): T {
  memory.set(key, { at: Date.now(), value });
  return value;
}

function recall<T>(key: string, ttlMs: number): T | undefined {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    memory.delete(key);
    return undefined;
  }
  return hit.value as T;
}

async function cached<T>(db: AppDb, key: string, ttlMs: number): Promise<T | undefined> {
  const local = recall<T>(key, ttlMs);
  if (local !== undefined) return local;
  const stored = await readCache<T>(db, key, ttlMs);
  if (stored == null) return undefined;
  remember(key, stored);
  return stored;
}

async function storeCache(db: AppDb, key: string, value: unknown): Promise<void> {
  remember(key, value);
  await writeCache(db, key, value);
}

async function acquireProvider(db: AppDb, provider: ProviderName): Promise<void> {
  const gate = providerGate(provider);
  const budget = gate === "helius" ? budgetPerMinute("rpc") : budgetPerMinute(provider);
  const gap = minGapMs(provider === "helius" ? "rpc" : provider);
  await enqueueProvider(gate, async () => {
    const used = await countGateCalls(db, gate, new Date(Date.now() - 60_000));
    const reserved = inFlight.get(gate) ?? 0;
    if (exceedsProviderBudget(used + reserved, budget)) {
      throw new RateLimitError(provider, 15_000, "budget");
    }
    const slot = await reserveProviderSlot(db, gate, gap, MAX_INLINE_WAIT_MS);
    if (!slot.ok) throw new RateLimitError(provider, slot.retryAfterMs, slot.reason);
    if (slot.waitMs > 0) await sleep(slot.waitMs);
    inFlight.set(gate, (inFlight.get(gate) ?? 0) + 1);
  });
}

function releaseProvider(provider: ProviderName): void {
  const gate = providerGate(provider);
  inFlight.set(gate, Math.max(0, (inFlight.get(gate) ?? 1) - 1));
}

type ProviderInit = RequestInit & { timeoutMs?: number };

async function providerFetch(db: AppDb, provider: ProviderName, url: string, init?: ProviderInit): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? 8_000;
  const rest = { ...(init ?? {}) };
  delete rest.timeoutMs;
  await acquireProvider(db, provider);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "user-agent": "KeelTracker/1.0",
          ...(rest.headers ?? {}),
        },
      });
    } catch (error) {
      await recordProviderCall(db, provider, 0);
      const message = error instanceof Error ? error.message : "request failed";
      throw new Error(redactSecrets(message));
    }
    await recordProviderCall(db, provider, response.status);
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 20_000;
      await noteProviderBackoff(db, providerGate(provider), wait);
      throw new RateLimitError(provider, wait, "http");
    }
    return response;
  } finally {
    releaseProvider(provider);
  }
}

type DexToken = { address?: string; name?: string; symbol?: string };

type DexPair = {
  dexId?: string;
  baseToken?: DexToken;
  quoteToken?: DexToken;
  priceUsd?: string | null;
  liquidity?: { usd?: number | null } | null;
  fdv?: number | null;
  marketCap?: number | null;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  info?: {
    imageUrl?: string | null;
    header?: string | null;
    websites?: { url?: string | null }[] | null;
    socials?: { type?: string | null; url?: string | null }[] | null;
  } | null;
};

function socialsFromPairs(pairs: DexPair[]): TokenSocials | null {
  const socials = emptySocials();
  for (const pair of pairs) {
    for (const site of pair.info?.websites ?? []) {
      const url = httpsUrl(site?.url);
      if (url && !socials.website) socials.website = url;
    }
    for (const social of pair.info?.socials ?? []) {
      const url = httpsUrl(social?.url);
      const kind = (social?.type ?? "").toLowerCase();
      if (!url) continue;
      if (!socials.twitter && (kind.includes("twitter") || kind.includes("x"))) socials.twitter = url;
      else if (!socials.telegram && kind.includes("telegram")) socials.telegram = url;
      else if (!socials.website) socials.website = url;
    }
  }
  return hasStoredSocials(socials) ? socials : null;
}

function num(value: unknown): number | null {
  return asNumber(value);
}

export function snapshotFromPairs(mint: string, pairs: DexPair[]): MarketSnapshot {
  const related = pairs.filter(
    (pair) => pair.baseToken?.address === mint || pair.quoteToken?.address === mint,
  );
  if (related.length === 0) return emptySnapshot("dexscreener");
  const based = related.filter((pair) => pair.baseToken?.address === mint);
  const pool = based.length > 0 ? based : related;
  const best = pool.reduce((left, right) =>
    (right.liquidity?.usd ?? 0) > (left.liquidity?.usd ?? 0) ? right : left,
  );
  const identity = best.baseToken?.address === mint ? best.baseToken : best.quoteToken;
  const price = best.baseToken?.address === mint ? num(best.priceUsd) : null;
  return {
    priceUsd: price,
    mcapUsd: num(best.marketCap) ?? num(best.fdv),
    liqUsd: num(best.liquidity?.usd),
    volM5: num(best.volume?.m5),
    volH1: num(best.volume?.h1),
    volH6: num(best.volume?.h6),
    volH24: num(best.volume?.h24),
    buysM5: num(best.txns?.m5?.buys),
    sellsM5: num(best.txns?.m5?.sells),
    buysH1: num(best.txns?.h1?.buys),
    sellsH1: num(best.txns?.h1?.sells),
    pairCount: related.length,
    symbol: blankToNull(identity?.symbol) ?? identityText(related, mint, "symbol"),
    name: blankToNull(identity?.name) ?? identityText(related, mint, "name"),
    imageUrl: imageForBase(based),
    dexId: best.dexId ?? null,
    source: "dexscreener",
    socials: socialsFromPairs(related),
  };
}

function profileUrl(value: unknown, host: "x.com" | "t.me"): string | null {
  const direct = httpsUrl(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  const handle = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,32}$/.test(handle)) return null;
  return `https://${host}/${handle}`;
}

function geckoSocials(attributes: Record<string, unknown>): TokenSocials | null {
  const socials = emptySocials();
  socials.twitter = profileUrl(attributes.twitter_handle, "x.com");
  socials.telegram = profileUrl(attributes.telegram_handle, "t.me");
  socials.website = Array.isArray(attributes.websites)
    ? (attributes.websites.map((site) => httpsUrl(site)).find((site): site is string => site != null) ?? null)
    : httpsUrl(attributes.websites);
  return hasStoredSocials(socials) ? socials : null;
}

function identityText(pairs: DexPair[], mint: string, key: "symbol" | "name"): string | null {
  for (const pair of pairs) {
    const token = pair.baseToken?.address === mint ? pair.baseToken : pair.quoteToken;
    const value = blankToNull(token?.[key]);
    if (value) return value;
  }
  return null;
}

/** Logos belong to the base token. A quote-side pair image is the other asset. */
function imageForBase(pairs: DexPair[]): string | null {
  const ordered = [...pairs].sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0));
  for (const pair of ordered) {
    const image = httpsUrl(pair.info?.imageUrl);
    if (image) return image;
  }
  return null;
}

export async function getDexSnapshots(db: AppDb, mints: string[], options?: {freshAfter?:Date}): Promise<Map<string, MarketSnapshot>> {
  const unique = [...new Set(mints)].slice(0, 30);
  const out = new Map<string, MarketSnapshot>();
  const missing: string[] = [];
  for (const mint of unique) {
    const hit = await cached<MarketSnapshot>(db, `dex:${mint}`, 90_000);
    if (hit?.observedAt && (!options?.freshAfter || new Date(hit.observedAt)>=options.freshAfter)) out.set(mint, hit);
    else missing.push(mint);
  }
  if (missing.length === 0) return out;
  const response = await providerFetch(
    db,
    "dexscreener",
    `https://api.dexscreener.com/tokens/v1/solana/${missing.join(",")}`,
  );
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("DexScreener returned an unexpected payload");
  const pairs = body as DexPair[];
  for (const mint of missing) {
    const snap = { ...snapshotFromPairs(mint, pairs), observedAt: new Date().toISOString() };
    out.set(mint, snap);
    await storeCache(db, `dex:${mint}`, snap);
  }
  return out;
}

type JupiterPrice = { usdPrice?: number; liquidity?: number; decimals?: number };

export async function getJupiterPrices(
  db: AppDb,
  mints: string[],
): Promise<Map<string, { priceUsd: number; liquidity: number | null; observedAt?: string }>> {
  const unique = [...new Set(mints)].slice(0, 50);
  const out = new Map<string, { priceUsd: number; liquidity: number | null; observedAt?: string }>();
  const missing: string[] = [];
  for (const mint of unique) {
    const hit = await cached<{ priceUsd: number; liquidity: number | null; observedAt?: string }>(db, `jup:${mint}`, 90_000);
    if (hit?.observedAt) out.set(mint, hit);
    else missing.push(mint);
  }
  if (missing.length === 0) return out;
  const headers: Record<string, string> = {};
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
  const response = await providerFetch(db, "jupiter", `https://api.jup.ag/price/v3?ids=${missing.join(",")}`, {
    headers,
  });
  if (!response.ok) throw new Error(`Jupiter HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, JupiterPrice>;
  for (const mint of missing) {
    const row = body[mint];
    const price = num(row?.usdPrice);
    const value = price == null ? null : { priceUsd: price, liquidity: num(row?.liquidity), observedAt: new Date().toISOString() };
    if (value) {
      out.set(mint, value);
      await storeCache(db, `jup:${mint}`, value);
    }
  }
  return out;
}

export type RugReport = {
  normalised: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  topHolderPct: number | null;
};

export function parseRugReport(body: unknown): RugReport {
  const record = (body ?? {}) as Record<string, unknown>;
  const normalised = num(record.score_normalised ?? record.scoreNormalised);
  const risks = Array.isArray(record.risks) ? record.risks : [];
  const names = risks.map((risk) => String((risk as { name?: string }).name ?? "").toLowerCase());
  const holders = (record.topHolders ?? record.top_holders) as { pct?: number; percentage?: number }[] | undefined;
  let top: number | null = null;
  if (Array.isArray(holders) && holders.length > 0) {
    const pct = num(holders[0]?.pct ?? holders[0]?.percentage);
    top = pct == null ? null : pct <= 1 ? pct * 100 : pct;
  }
  const known = normalised != null || names.length > 0;
  return {
    normalised,
    mintRevoked: known ? !names.some((name) => name.includes("mint authority") || name.includes("mint enabled")) : null,
    freezeRevoked: known ? !names.some((name) => name.includes("freeze")) : null,
    topHolderPct: top,
  };
}

export async function loadRug(db: AppDb, mint: string): Promise<RugReport | null> {
  const hit = await cached<RugReport>(db, `rug:${mint}`, 2 * 60 * 60_000);
  if (hit) return hit;
  const response = await providerFetch(db, "rugcheck", `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`RugCheck HTTP ${response.status}`);
  const report = parseRugReport(await response.json());
  await storeCache(db, `rug:${mint}`, report);
  return report;
}

export async function loadGecko(db: AppDb, mint: string): Promise<MarketSnapshot | null> {
  const hit = await cached<MarketSnapshot>(db, `gecko:${mint}`, 3 * 60_000);
  if (hit?.observedAt) return hit;
  const response = await providerFetch(
    db,
    "geckoterminal",
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
  const body = (await response.json()) as {
    data?: { attributes?: Record<string, unknown> };
  };
  const attributes = body.data?.attributes;
  if (!attributes) {
      return null;
  }
  const volume = (attributes.volume_usd ?? {}) as Record<string, unknown>;
  const snap: MarketSnapshot = {
    priceUsd: num(attributes.price_usd),
    mcapUsd: num(attributes.market_cap_usd) ?? num(attributes.fdv_usd),
    liqUsd: num(attributes.total_reserve_in_usd),
    volM5: num(volume.m5),
    volH1: num(volume.h1),
    volH6: num(volume.h6),
    volH24: num(volume.h24),
    buysM5: null,
    sellsM5: null,
    buysH1: null,
    sellsH1: null,
    pairCount: 1,
    symbol: blankToNull(typeof attributes.symbol === "string" ? attributes.symbol : null),
    name: blankToNull(typeof attributes.name === "string" ? attributes.name : null),
    imageUrl: httpsUrl(attributes.image_url),
    dexId: "geckoterminal",
    source: "geckoterminal",
    observedAt: new Date().toISOString(),
    socials: geckoSocials(attributes),
  };
  await storeCache(db, `gecko:${mint}`, snap);
  return snap;
}

function applyPublicMeta(snap: MarketSnapshot, meta: PublicTokenMeta, allowPair: boolean): MarketSnapshot {
  const next: MarketSnapshot = {
    ...snap,
    symbol: snap.symbol ?? meta.symbol,
    name: snap.name ?? meta.name,
    imageUrl: snap.imageUrl ?? httpsUrl(meta.imageUrl),
  };
  if (allowPair && meta.observedAt && next.pairCount === 0 && (meta.priceUsd != null || meta.mcapUsd != null)) {
    next.priceUsd = next.priceUsd ?? meta.priceUsd;
    next.mcapUsd = next.mcapUsd ?? meta.mcapUsd;
    next.pairCount = 1;
    next.dexId = next.dexId ?? meta.source;
    next.source = meta.source;
    next.observedAt = meta.observedAt;
  }
  return next;
}

async function softJson(db: AppDb, provider: ProviderName, url: string): Promise<unknown | null> {
  try {
    const response = await providerFetch(db, provider, url, { timeoutMs: 4_000 });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function lookupPublicMetadata(db: AppDb, mint: string): Promise<PublicTokenMeta | null> {
  const hit = await cached<PublicTokenMeta>(db, `meta:${mint}`, 10 * 60_000);
  if (hit) return hit;
  const pump = parsePumpCoin(await softJson(db, "pump", `https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`));
  const gmgn = parseGmgnToken(
    await softJson(db, "gmgn", `https://gmgn.ai/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`),
  );
  const merged = mergeMeta(pump, gmgn);
  if (!merged) return null;
  const stamped = { ...merged, observedAt: new Date().toISOString() };
  await storeCache(db, `meta:${mint}`, stamped);
  return stamped;
}

export async function loadMarket(db: AppDb, mint: string, allowGecko: boolean): Promise<MarketSnapshot> {
  const dex = await getDexSnapshots(db, [mint]);
  let snap = dex.get(mint) ?? emptySnapshot("dexscreener");
  if (snap.pairCount === 0 && allowGecko) {
    try {
      const fallback = await loadGecko(db, mint);
      if (fallback && (fallback.pairCount > 0 || fallback.priceUsd != null)) {
        snap = { ...fallback, socials: snap.socials ?? fallback.socials ?? null, symbol: fallback.symbol ?? snap.symbol, name: fallback.name ?? snap.name, imageUrl: fallback.imageUrl ?? snap.imageUrl };
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
    }
  }
  if (allowGecko && (snap.pairCount === 0 || !snap.symbol || !snap.name || !snap.imageUrl)) {
    try {
      const extra = await lookupPublicMetadata(db, mint);
      if (extra) snap = applyPublicMeta(snap, extra, snap.pairCount === 0);
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
    }
  }
  return snap;
}

type RpcResponse<T> = { result?: T; error?: { message?: string } };

async function rpc<T>(db: AppDb, method: string, params: unknown[]): Promise<T> {
  const response = await providerFetch(db, "rpc", rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as RpcResponse<T>;
  if (body.error) throw new Error(body.error.message || "RPC error");
  return body.result as T;
}

export async function getSignatures(db: AppDb, address: string, until: string | null, before?: string | null) {
  const config: { limit: number; until?: string; before?: string } = { limit: 40 };
  if (until) config.until = until;
  if (before) config.before = before;
  const result = await rpc<{ signature: string; slot?: number; blockTime?: number | null; err?: unknown }[] | null>(
    db,
    "getSignaturesForAddress",
    [address, config],
  );
  return result ?? [];
}

export async function getTransaction(db: AppDb, signature: string) {
  return rpc<unknown>(db, "getTransaction", [signature, PARSED_TX_CONFIG]);
}

export async function getParsedTransaction(db: AppDb, signature: string) {
  return rpc<unknown>(db, "getParsedTransaction", [signature, PARSED_TX_METHOD_CONFIG]);
}

export async function getEnhancedTransaction(db: AppDb, signature: string): Promise<HeliusLike | null> {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return null;
  const cachedTx = await cached<HeliusLike>(db, `helius:tx:${signature}`, 60 * 60_000);
  if (cachedTx) return cachedTx;
  const response = await providerFetch(db, "helius", `https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(key)}`, {
    method: "POST",
    timeoutMs: 4_000,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: [signature] }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as HeliusLike[] | { transactions?: HeliusLike[] };
  const rows = Array.isArray(body) ? body : body.transactions ?? [];
  const match = rows.find((row) => row?.signature === signature) ?? rows[0] ?? null;
  if (match?.signature) await storeCache(db, `helius:tx:${signature}`, match);
  return match;
}

export async function findExternalTrade(db: AppDb, mint: string, signature: string, wallet: string): Promise<ExternalTrade | null> {
  const pumpBody = await softJson(
    db,
    "pump",
    `https://frontend-api-v3.pump.fun/trades/all/${encodeURIComponent(mint)}?limit=40&offset=0`,
  );
  const pump = tradeFromRows(pumpBody, signature, wallet, mint, "pump.fun");
  if (pump) return pump;
  const gmgnBody = await softJson(
    db,
    "gmgn",
    `https://gmgn.ai/defi/quotation/v1/trades/sol/${encodeURIComponent(mint)}?limit=30`,
  );
  return tradeFromRows(gmgnBody, signature, wallet, mint, "gmgn");
}

export async function tokenBalance(db: AppDb, wallet: string, mint: string): Promise<number> {
  const result = await rpc<{
    value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }[];
  } | null>(db, "getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed" }]);
  const accounts = result?.value ?? [];
  return accounts.reduce((sum, account) => sum + (account.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
}
