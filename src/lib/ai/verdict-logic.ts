import { createHash } from "node:crypto";
import { z } from "zod";
import type { AiVerdictBody, HolderThesis, ShadowBucket } from "@/lib/ai/types";
import { compactUsd, fmtAge, fmtTime, signedPct } from "@/lib/format";
import { gainPct, positive, resolveGain } from "@/lib/logic/gains";

export const DEFAULT_VERDICT_MODEL = "google/gemini-2.5-flash";
export const VERDICT_MODEL_FALLBACKS = ["google/gemini-3.6-flash"] as const;
export const DEFAULT_DAILY_CAP = 60;
export const VERDICT_GAP_MS = 30 * 60_000;
export const VERDICT_PRICE_MOVE_PCT = 30;
export const VERDICT_BATCH_LIMIT = 2;
export const VERDICT_SCAN_LIMIT = 6;
export const MODEL_CALL_TIMEOUT_MS = 15_000;
export const MODEL_CALL_MIN_MS = 1_500;
export const DISPLAY_TIME_ZONE = "Asia/Kolkata";

export const VERDICT_SYSTEM_PROMPT = [
  "You are judging one Solana memecoin candidate for a shadow review. You do not trade, score, or archive. Return a single JSON object and no other text.",
  "",
  "Judging rules:",
  "- Weigh the quality of reasoning in the holder theses heavily. A specific mechanism, catalyst, or risk beats a slogan.",
  "- These are often low-cap tokens. A good thesis can still work days later. Early FOMO holders having already sold is only a soft signal. It is not a strict negative and it is not a veto.",
  "- Do not use how many wallets bought, how many theses exist, likes, replies, or any crowd count as strength. Judge the content of each thesis, not the count.",
  "- Red flags to name when the text supports them: dev sold, bundled or farmed supply, honeypot or rug talk, a pure shill with no reasoning, holders who have exited while still posting bullish.",
  "- If there are no theses, judge the market snapshot alone and keep conviction modest. Do not invent a narrative nobody wrote.",
  "- verdict is exactly strong, ok, or avoid. strong means the written reasoning is specific and the snapshot does not contradict it. ok means mixed or thin reasoning and no hard red flag. avoid means a real red flag or theses that are only shill.",
  "- conviction is an integer from 0 to 100 for how sure you are of that verdict.",
  "- bullPoints is 2 or 3 short strings grounded in the theses or the snapshot.",
  "- redFlags is an array of short strings, empty when none apply.",
  "- narrative is one line.",
  "- invalidation is what would prove this verdict wrong.",
  "- holderSummary covers whether the authors are holding or closed and how that relates to what they wrote.",
  "- reasoning is one short paragraph.",
  "",
  "JSON keys: verdict, conviction, bullPoints, redFlags, narrative, invalidation, holderSummary, reasoning.",
].join("\n");

const line = z.string().trim().min(1).max(400);
const verdictJsonSchema = z.object({
  verdict: z.enum(["strong", "ok", "avoid"]),
  conviction: z.number().int().min(0).max(100),
  bullPoints: z.array(line).min(2).max(3),
  redFlags: z.array(line).max(6),
  narrative: z.string().trim().min(1).max(200),
  invalidation: line,
  holderSummary: line,
  reasoning: z.string().trim().min(1).max(1000),
});

export type VerdictConfig = {
  gatewayUrl: string | null;
  apiKey: string | null;
  model: string;
  dailyCap: number;
};

export function loadVerdictConfig(env: Record<string, string | undefined> = process.env): VerdictConfig {
  const capRaw = env.AI_VERDICT_DAILY_CAP?.trim();
  let dailyCap = DEFAULT_DAILY_CAP;
  if (capRaw) {
    const parsed = Number(capRaw);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000) dailyCap = parsed;
  }
  return {
    gatewayUrl: env.OMO_AI_GATEWAY_URL?.trim() || null,
    apiKey: env.OMO_MODEL_API_KEY?.trim() || null,
    model: env.AI_VERDICT_MODEL?.trim() || DEFAULT_VERDICT_MODEL,
    dailyCap,
  };
}

export function gatewayConfigured(config: VerdictConfig): boolean {
  return Boolean(config.gatewayUrl && config.apiKey);
}

export function modelChain(primary: string): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const id of [primary, ...VERDICT_MODEL_FALLBACKS]) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    chain.push(trimmed);
  }
  return chain;
}

export function istDayStart(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return new Date(`${parts}T00:00:00+05:30`);
}

export function chatCompletionsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function isUnsupportedModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /invalid model|model_not_found|unsupported model|does not exist|not a valid model|no endpoints found/i.test(message);
}

export type TriggerReason = "first" | "price" | "theses" | "stage";
export type SkipReason = "not_candidate" | "gap" | "unchanged" | "cap";
export type ThesisSignal = "unknown" | "same" | "new";

export type TriggerDecision =
  | { run: true; reason: TriggerReason }
  | { run: false; reason: SkipReason };

export function movedAtLeast(previous: number | null, current: number | null, pct = VERDICT_PRICE_MOVE_PCT): boolean {
  const before = positive(previous);
  const after = positive(current);
  if (before == null || after == null) return false;
  return Math.abs(after - before) / before >= pct / 100;
}

export function marketMoved(
  previous: { priceUsd: number | null; mcapUsd: number | null },
  current: { priceUsd: number | null; mcapUsd: number | null },
): boolean {
  if (positive(previous.priceUsd) != null && positive(current.priceUsd) != null) {
    return movedAtLeast(previous.priceUsd, current.priceUsd);
  }
  return movedAtLeast(previous.mcapUsd, current.mcapUsd);
}

export function stageChanged(previous: string | null, current: string | null): boolean {
  if (!current) return false;
  return previous !== current;
}

/**
 * Shadow trigger. Gap is measured from the last attempt, including an unavailable one.
 * Price, stage, and theses are measured from the last real judgement so a failed
 * attempt does not swallow the reason to try again.
 */
export function decideAiVerdict(input: {
  status: string;
  nowMs: number;
  lastAttemptAtMs: number | null;
  lastJudgement: { priceUsd: number | null; mcapUsd: number | null; stage: string | null } | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  stage: string | null;
  theses: ThesisSignal;
  usedToday: number;
  dailyCap: number;
  gapMs?: number;
}): TriggerDecision {
  if (input.status !== "candidate") return { run: false, reason: "not_candidate" };
  const gapMs = input.gapMs ?? VERDICT_GAP_MS;
  if (input.lastAttemptAtMs != null && input.nowMs - input.lastAttemptAtMs < gapMs) {
    return { run: false, reason: "gap" };
  }
  const capped = input.usedToday >= input.dailyCap;
  if (!input.lastJudgement) return capped ? { run: false, reason: "cap" } : { run: true, reason: "first" };
  if (marketMoved(input.lastJudgement, input)) {
    return capped ? { run: false, reason: "cap" } : { run: true, reason: "price" };
  }
  if (stageChanged(input.lastJudgement.stage, input.stage)) {
    return capped ? { run: false, reason: "cap" } : { run: true, reason: "stage" };
  }
  if (input.theses === "new") return capped ? { run: false, reason: "cap" } : { run: true, reason: "theses" };
  return { run: false, reason: "unchanged" };
}

export function thesisFingerprint(theses: Pick<HolderThesis, "at" | "who" | "text">[]): string {
  const parts = theses
    .map((thesis) => `${thesis.at}\n${thesis.who}\n${thesis.text}`)
    .sort();
  return createHash("sha256").update(parts.join("\n---\n")).digest("hex");
}

export function thesisSignal(previousFingerprint: string | null, theses: Pick<HolderThesis, "at" | "who" | "text">[]): ThesisSignal {
  const next = thesisFingerprint(theses);
  if (!previousFingerprint) return next === thesisFingerprint([]) ? "same" : "new";
  return previousFingerprint === next ? "same" : "new";
}

export function newestThesisAt(theses: Pick<HolderThesis, "at">[]): string | null {
  let bestMs = Number.NEGATIVE_INFINITY;
  let best: string | null = null;
  for (const thesis of theses) {
    const ms = Date.parse(thesis.at);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = new Date(ms).toISOString();
  }
  return best;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashInputs(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function extractJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!trimmed) return { ok: false, error: "empty" };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, error: "no json object" };
    try {
      return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) as unknown };
    } catch {
      return { ok: false, error: "invalid json" };
    }
  }
}

function asStringList(value: unknown, limit: number): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const lines: string[] = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim().slice(0, 180);
    if (!text) continue;
    lines.push(text);
    if (lines.length >= limit) break;
  }
  return lines;
}

function oneLine(value: unknown, max: number): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeVerdict(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const convictionRaw = source.conviction;
  const convictionNumber = typeof convictionRaw === "string" ? Number(convictionRaw) : convictionRaw;
  const conviction = typeof convictionNumber === "number" && Number.isFinite(convictionNumber)
    ? Math.round(convictionNumber)
    : convictionRaw;
  const verdict = typeof source.verdict === "string" ? source.verdict.trim().toLowerCase() : source.verdict;
  return {
    verdict,
    conviction,
    bullPoints: asStringList(source.bullPoints ?? source.bull_points, 3),
    redFlags: asStringList(source.redFlags ?? source.red_flags, 6),
    narrative: oneLine(source.narrative ?? source.meta, 200),
    invalidation: oneLine(source.invalidation, 400),
    holderSummary: oneLine(
      source.holderSummary ?? source.holder_summary ?? source.holderBehaviour ?? source.holder_behaviour,
      400,
    ),
    reasoning: oneLine(source.reasoning, 1000),
  };
}

export function parseVerdictPayload(input: unknown): { ok: true; value: AiVerdictBody } | { ok: false; error: string } {
  const parsed = verdictJsonSchema.safeParse(normalizeVerdict(input));
  if (!parsed.success) {
    const error = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error };
  }
  return { ok: true, value: parsed.data };
}

export function parseVerdictText(text: string): { ok: true; value: AiVerdictBody } | { ok: false; error: string } {
  const extracted = extractJsonObject(text);
  if (!extracted.ok) return extracted;
  return parseVerdictPayload(extracted.value);
}

export type VerdictMarket = {
  mint: string;
  symbol: string | null;
  name: string | null;
  stage: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liqUsd: number | null;
  volM5: number | null;
  volH1: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  age: string;
  firstAlertAt: string | null;
  firstAlertPriceUsd: number | null;
  firstAlertMcapUsd: number | null;
  gainPct: number | null;
  gainBasis: "price" | "mcap" | null;
  athGainPct: number | null;
  rugcheckNormalised: number | null;
  topHolderPct: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  venue: string | null;
};

export function gainSinceFirstAlert(token: {
  lastPriceUsd: number | null;
  firstAlertPriceUsd: number | null;
  lastMcapUsd: number | null;
  firstAlertMcapUsd: number | null;
  athPriceUsd: number | null;
  athGainPct: number | null;
}): { gainPct: number | null; athGainPct: number | null } {
  const gain = resolveGain({
    lastPrice: token.lastPriceUsd,
    entryPrice: token.firstAlertPriceUsd,
    lastMcap: token.lastMcapUsd,
    entryMcap: token.firstAlertMcapUsd,
  });
  return {
    gainPct: gain.gainPct,
    athGainPct: gainPct(token.athPriceUsd, token.firstAlertPriceUsd) ?? token.athGainPct,
  };
}

function money(value: number | null): string {
  return value == null ? "missing" : compactUsd(value);
}

function count(value: number | null): string {
  return value == null ? "missing" : String(value);
}

function yesNo(value: boolean | null): string {
  if (value == null) return "missing";
  return value ? "yes" : "no";
}

export function buildVerdictPrompt(market: VerdictMarket, theses: HolderThesis[]): { system: string; user: string } {
  const lines = [
    `Token ${market.symbol ? `$${market.symbol.replace(/^\$/, "")}` : "symbol missing"}${market.name ? ` (${market.name})` : ""}`,
    `Mint ${market.mint}`,
    `Stage ${market.stage ?? "missing"} · venue ${market.venue ?? "missing"} · age ${market.age}`,
    `Price ${money(market.priceUsd)} · mcap ${money(market.mcapUsd)} · liquidity ${money(market.liqUsd)}`,
    `Volume 5m ${money(market.volM5)} · volume 1h ${money(market.volH1)}`,
    `First alert ${market.firstAlertAt ? fmtTime(market.firstAlertAt) : "missing"} · price ${money(market.firstAlertPriceUsd)} · mcap ${money(market.firstAlertMcapUsd)}`,
    `Gain since first alert ${signedPct(market.gainPct)}${market.gainBasis ? ` (${market.gainBasis})` : ""} · ATH gain since first alert ${signedPct(market.athGainPct)}`,
    `RugCheck normalised ${market.rugcheckNormalised == null ? "missing" : market.rugcheckNormalised} · top holder ${market.topHolderPct == null ? "missing" : `${market.topHolderPct}%`} · mint revoked ${yesNo(market.mintRevoked)} · freeze revoked ${yesNo(market.freezeRevoked)}`,
    `Tape only, not a strength signal: buys/sells 5m ${count(market.buysM5)}/${count(market.sellsM5)} · buys/sells 1h ${count(market.buysH1)}/${count(market.sellsH1)}.`,
    "",
    "Holder theses. Judge each post's reasoning. Do not treat how many there are as strength.",
  ];
  if (theses.length === 0) {
    lines.push("No holder theses were returned.");
  } else {
    for (const thesis of theses) {
      const position = thesis.closed
        ? `closed, realized ${compactUsd(thesis.realizedUsd)} (${signedPct(thesis.pnlPct)})`
        : `holding ${compactUsd(thesis.sizeUsd)}, unrealized ${compactUsd(thesis.unrealizedUsd)} (${signedPct(thesis.pnlPct)})`;
      lines.push(
        `- @${thesis.who} · ${position} · ${thesis.likes} likes · ${thesis.replies} replies · ${fmtTime(thesis.at)}`,
      );
      lines.push(`  "${thesis.text}"`);
    }
  }
  return { system: VERDICT_SYSTEM_PROMPT, user: lines.join("\n") };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return round1(value);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return round1(total / values.length);
}

export function summarizeShadowBuckets(
  rows: { verdict: string; gainPct: number | null; athGainPct: number | null }[],
): ShadowBucket[] {
  const labels = ["strong", "ok", "avoid"] as const;
  return labels.map((verdict) => {
    const matched = rows.filter((row) => row.verdict === verdict);
    const gains = matched.map((row) => row.gainPct).filter((value): value is number => value != null && Number.isFinite(value));
    const aths = matched.map((row) => row.athGainPct).filter((value): value is number => value != null && Number.isFinite(value));
    return {
      verdict,
      n: matched.length,
      withGain: gains.length,
      avgGainPct: average(gains),
      medianGainPct: median(gains),
      avgAthGainPct: average(aths),
      medianAthGainPct: median(aths),
    };
  });
}

export function marketAge(from: Date | null, now: Date): string {
  return fmtAge(from, now.getTime());
}
