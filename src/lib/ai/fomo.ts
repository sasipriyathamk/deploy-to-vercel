import type { HolderThesis } from "@/lib/ai/types";

const API = "https://prod-api.fomo.family";
const SESSIONS = "https://auth.privy.io/api/v1/sessions";
/** Public Privy app id used by fomo.family in the browser. Not a secret. */
const PRIVY_APP_ID = "cm6h485o300n3zj9yl6vpedq7";
const SOLANA_NETWORK_ID = 1399811149;
const RESPONSE_TTL_MS = 120_000;
const DEFAULT_GAP_MS = 220;

export type FomoFailure = "missing_env" | "fomo_auth" | "fomo_401" | "fomo_429" | "fomo_html" | "fomo_error";

export type FomoRead =
  | { ok: true; theses: HolderThesis[] }
  | { ok: false; reason: FomoFailure };

type ThesisItem = {
  createdAt?: string;
  displayName?: string;
  userHandle?: string;
  numReplies?: number;
  comment?: { comment?: string; numLikes?: number };
  authorTrade?: {
    usdValue?: number;
    unrealizedPnlUsd?: number;
    realizedPnlUsd?: number;
    percentageUnrealizedPnl?: number;
    percentageRealizedPnl?: number;
    closedAt?: string | null;
  };
};

let sessionToken: string | null = null;
let sessionExpiresAt = 0;
let sessionInFlight: Promise<string | null> | null = null;
let gapMs = DEFAULT_GAP_MS;
let chain: Promise<unknown> = Promise.resolve();
const responses = new Map<string, { at: number; body: unknown }>();

export function fomoEnvPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FOMO_PRIVY_REFRESH_TOKEN?.trim());
}

export function resetFomoForTests(): void {
  sessionToken = null;
  sessionExpiresAt = 0;
  sessionInFlight = null;
  gapMs = DEFAULT_GAP_MS;
  responses.clear();
  chain = Promise.resolve();
}

export function setFomoGapForTests(ms: number): void {
  gapMs = ms;
}

function abortTimeoutMs(defaultMs: number, deadlineMs?: number, now = Date.now()): number | null {
  if (deadlineMs == null) return defaultMs;
  const left = deadlineMs - now;
  if (left < 500) return null;
  return Math.min(defaultMs, left);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "error";
  return message.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 160);
}

function jwtExp(jwt: string): number {
  try {
    const part = jwt.split(".")[1];
    if (!part) return 0;
    const pad = part + "=".repeat((4 - (part.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      exp?: number;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function num(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Junk posts: raw invite links, single emoji, empty noise. */
export function isSubstantive(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const stripped = trimmed.replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]/gi, "");
  if (stripped.length < 3) return false;
  if (/discord\.gg|t\.me\/|join:/i.test(trimmed) && stripped.length < 40) return false;
  return true;
}

export function parseThesisFeed(payload: unknown, mint: string, limit = 8): HolderThesis[] {
  const items = (payload as { responseObject?: { items?: ThesisItem[] } } | null)?.responseObject?.items ?? [];
  const theses = items
    .map((item) => {
      const trade = item.authorTrade ?? {};
      const closed = Boolean(trade.closedAt);
      return {
        who: str(item.userHandle) || str(item.displayName) || "a holder",
        text: str(item.comment?.comment).replace(/\s+/g, " ").trim().slice(0, 600),
        sizeUsd: num(trade.usdValue),
        unrealizedUsd: num(trade.unrealizedPnlUsd),
        realizedUsd: num(trade.realizedPnlUsd),
        pnlPct: closed ? num(trade.percentageRealizedPnl) : num(trade.percentageUnrealizedPnl),
        closed,
        likes: num(item.comment?.numLikes),
        replies: num(item.numReplies),
        at: str(item.createdAt),
      } satisfies HolderThesis;
    })
    .filter((thesis) => isSubstantive(thesis.text));
  theses.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
  return theses.slice(0, limit);
}

export function interpretFomoHttp(status: number, body: string): { ok: true; json: unknown } | { ok: false; reason: FomoFailure } {
  if (status === 401) return { ok: false, reason: "fomo_401" };
  if (status === 429) return { ok: false, reason: "fomo_429" };
  const trimmed = body.trimStart();
  if (!trimmed || trimmed.startsWith("<")) return { ok: false, reason: trimmed.startsWith("<") ? "fomo_html" : "fomo_error" };
  if (status < 200 || status >= 300) return { ok: false, reason: "fomo_error" };
  try {
    return { ok: true, json: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, reason: "fomo_error" };
  }
}

function queue<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.then(
    () => new Promise((resolve) => setTimeout(resolve, gapMs)),
    () => new Promise((resolve) => setTimeout(resolve, gapMs)),
  );
  return next;
}

async function mintSession(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv, deadlineMs?: number): Promise<string | null> {
  const refresh = env.FOMO_PRIVY_REFRESH_TOKEN?.trim();
  if (!refresh) return null;
  const timeoutMs = abortTimeoutMs(8_000, deadlineMs);
  if (timeoutMs == null) return null;
  try {
    const response = await fetchImpl(SESSIONS, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "privy-app-id": PRIVY_APP_ID,
        "privy-client": "react-auth:2.28.1",
        origin: "https://fomo.family",
        referer: "https://fomo.family/",
      },
      body: JSON.stringify({ refresh_token: refresh }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.warn(`[keel] fomo session refresh failed status=${response.status}`);
      return null;
    }
    const body = (await response.json()) as { token?: string };
    if (!body.token) return null;
    sessionToken = body.token;
    sessionExpiresAt = jwtExp(body.token) || Date.now() + 45 * 60_000;
    return sessionToken;
  } catch (error) {
    console.warn(`[keel] fomo session refresh error ${safeError(error)}`);
    return null;
  }
}

async function accessToken(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
  override?: string | null,
  deadlineMs?: number,
): Promise<string | null> {
  if (override) return override;
  if (!env.FOMO_PRIVY_REFRESH_TOKEN?.trim()) return null;
  if (sessionToken && Date.now() < sessionExpiresAt - 60_000) return sessionToken;
  if (!sessionInFlight) {
    sessionInFlight = mintSession(fetchImpl, env, deadlineMs).finally(() => {
      sessionInFlight = null;
    });
  }
  return sessionInFlight;
}

async function requestFeed(
  mint: string,
  token: string,
  fetchImpl: typeof fetch,
  retryDelayMs: number,
  deadlineMs?: number,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: FomoFailure }> {
  const path = `/feed/token/thesis?tokenAddress=${encodeURIComponent(mint)}&networkId=${SOLANA_NETWORK_ID}&limit=40&threshold=0`;
  const headers: Record<string, string> = {
    accept: "*/*",
    authorization: `Bearer ${token}`,
    origin: "https://fomo.family",
    referer: "https://fomo.family/",
    "x-supported-chains": String(SOLANA_NETWORK_ID),
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  };
  let last: { ok: false; reason: FomoFailure } = { ok: false, reason: "fomo_error" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutMs = abortTimeoutMs(7_000, deadlineMs);
    if (timeoutMs == null) return last;
    try {
      const response = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      const interpreted = interpretFomoHttp(response.status, text);
      if (interpreted.ok) return interpreted;
      last = interpreted;
      if (interpreted.reason === "fomo_429" && attempt === 0) {
        if (deadlineMs != null && Date.now() + retryDelayMs >= deadlineMs) return interpreted;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (interpreted.reason === "fomo_401") return interpreted;
      return interpreted;
    } catch (error) {
      console.warn(`[keel] fomo thesis read error ${safeError(error)}`);
      return { ok: false, reason: "fomo_error" };
    }
  }
  return last;
}

export async function readHolderTheses(
  mint: string,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    token?: string | null;
    retryDelayMs?: number;
    now?: number;
    limit?: number;
    deadlineMs?: number;
  } = {},
): Promise<FomoRead> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const path = `/feed/token/thesis?tokenAddress=${encodeURIComponent(mint)}&networkId=${SOLANA_NETWORK_ID}&limit=40&threshold=0`;
  const now = options.now ?? Date.now();
  const cached = responses.get(path);
  if (cached && now - cached.at < RESPONSE_TTL_MS) {
    return { ok: true, theses: parseThesisFeed(cached.body, mint, options.limit ?? 8) };
  }
  if (!options.token && !env.FOMO_PRIVY_REFRESH_TOKEN?.trim()) return { ok: false, reason: "fomo_auth" };
  if (abortTimeoutMs(8_000, options.deadlineMs, now) == null) return { ok: false, reason: "fomo_error" };
  const token = await accessToken(fetchImpl, env, options.token, options.deadlineMs);
  if (!token) return { ok: false, reason: "fomo_auth" };
  const result = await queue(() => requestFeed(mint, token, fetchImpl, options.retryDelayMs ?? 800, options.deadlineMs));
  if (!result.ok && result.reason === "fomo_401" && !options.token) {
    sessionToken = null;
    sessionExpiresAt = 0;
    if (abortTimeoutMs(8_000, options.deadlineMs) == null) return result;
    const refreshed = await accessToken(fetchImpl, env, undefined, options.deadlineMs);
    if (!refreshed) return { ok: false, reason: "fomo_auth" };
    const retry = await queue(() => requestFeed(mint, refreshed, fetchImpl, options.retryDelayMs ?? 800, options.deadlineMs));
    if (!retry.ok) return retry;
    responses.set(path, { at: now, body: retry.json });
    return { ok: true, theses: parseThesisFeed(retry.json, mint, options.limit ?? 8) };
  }
  if (!result.ok) return result;
  responses.set(path, { at: now, body: result.json });
  if (responses.size > 60) {
    for (const [key, value] of responses) {
      if (now - value.at > RESPONSE_TTL_MS) responses.delete(key);
    }
  }
  return { ok: true, theses: parseThesisFeed(result.json, mint, options.limit ?? 8) };
}
