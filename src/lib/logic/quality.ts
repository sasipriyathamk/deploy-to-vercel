import type { ScoreBreakdown } from "@/lib/logic/score";

/** Missing or stale inputs. Each one lowers the diagnostic score. None of these change judging. */
export const MISSING_LABELS = [
  "no_dex_pair",
  "no_mcap",
  "no_liquidity",
  "no_holders",
  "no_rugcheck",
  "no_authorities",
  "parse_failed",
  "no_entry",
  "no_first_alert",
  "stale_market_data",
  "no_socials",
  "no_image",
] as const;

export type MissingLabel = (typeof MISSING_LABELS)[number];

/** Ways the current numbers can overstate a token. They do not change the trade score. */
export const FLAG_CODES = [
  "safety_unknown_scored_neutral",
  "late_entry",
  "score_capped",
  "weak_watch_promotion",
  "cap_above_low_cap_band",
  "stale_market_data",
  "parse_gap",
] as const;

export type FlagCode = (typeof FLAG_CODES)[number];

export const STALE_MARKET_MS = 30 * 60_000;
export const LATE_ENTRY_MS = 15 * 60_000;
/** Same ceiling as the T5 market-cap band. Diagnostic only. */
export const LOW_CAP_BAND_USD = 5_000_000;

export type TokenSocials = {
  website: string | null;
  twitter: string | null;
  telegram: string | null;
};

export type QualityFlag =
  | { code: "safety_unknown_scored_neutral"; unknown: ("holders" | "authorities" | "rugcheck")[] }
  | { code: "late_entry"; minutes: number; gainVsFirstSeenPct: number | null }
  | { code: "score_capped"; raw: number }
  | { code: "weak_watch_promotion" }
  | { code: "cap_above_low_cap_band"; mcapUsd: number }
  | { code: "stale_market_data"; ageMinutes: number | null }
  | { code: "parse_gap"; events: number };

export type DataQuality = {
  score: number;
  missing: MissingLabel[];
  flags: QualityFlag[];
};

export type QualityToken = {
  pairCount: number | null;
  lastMcapUsd: number | null;
  lastLiqUsd: number | null;
  topHolderPct: number | null;
  rugcheckNormalised: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  sniperBuyTx: string | null;
  entryAt: Date | null;
  entryPriceUsd: number | null;
  firstAlertAt: Date | null;
  firstSeenAt: Date | null;
  firstSeenPriceUsd: number | null;
  lastCheckedAt: Date | null;
  imageUrl: string | null;
  socials: TokenSocials | null;
  scoreBreakdown: ScoreBreakdown | null;
  promotionHits: string | null;
  unknownEvents?: number;
};

export function emptySocials(): TokenSocials {
  return { website: null, twitter: null, telegram: null };
}

export function hasStoredSocials(socials: TokenSocials | null | undefined): boolean {
  if (!socials) return false;
  return Boolean(socials.website || socials.twitter || socials.telegram);
}

export function parseSocials(value: unknown): TokenSocials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const socials: TokenSocials = {
    website: typeof row.website === "string" && row.website.trim() ? row.website.trim() : null,
    twitter: typeof row.twitter === "string" && row.twitter.trim() ? row.twitter.trim() : null,
    telegram: typeof row.telegram === "string" && row.telegram.trim() ? row.telegram.trim() : null,
  };
  return hasStoredSocials(socials) ? socials : null;
}

/** Uncapped sum of the stored breakdown. `total` is already clamped to 0–100. */
export function rawBreakdownScore(breakdown: ScoreBreakdown): number {
  return (
    breakdown.base +
    breakdown.liquidity +
    breakdown.volume +
    breakdown.buyPressure +
    breakdown.holders +
    breakdown.authorities +
    breakdown.rugcheck +
    breakdown.sniperHold +
    breakdown.age +
    breakdown.venue +
    breakdown.drawdown
  );
}

export function isWeakWatchHits(hits: string | null | undefined): boolean {
  if (!hits) return false;
  const parts = new Set(
    hits
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  return parts.size === 2 && parts.has("liq") && parts.has("alive");
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function gainVsFirstSeen(entryPrice: number | null, firstPrice: number | null): number | null {
  if (entryPrice == null || firstPrice == null || !Number.isFinite(entryPrice) || !Number.isFinite(firstPrice) || firstPrice === 0) {
    return null;
  }
  return round1(((entryPrice - firstPrice) / firstPrice) * 100);
}

export function buildDataQuality(token: QualityToken, now = new Date()): DataQuality {
  const missing: MissingLabel[] = [];
  if (token.pairCount == null || token.pairCount <= 0) missing.push("no_dex_pair");
  if (token.lastMcapUsd == null) missing.push("no_mcap");
  if (token.lastLiqUsd == null) missing.push("no_liquidity");
  if (token.topHolderPct == null) missing.push("no_holders");
  if (token.rugcheckNormalised == null) missing.push("no_rugcheck");
  if (token.mintRevoked == null && token.freezeRevoked == null) missing.push("no_authorities");
  if (!token.sniperBuyTx) missing.push("parse_failed");
  if (!token.entryAt) missing.push("no_entry");
  if (!token.firstAlertAt) missing.push("no_first_alert");
  const checkedAge = token.lastCheckedAt ? now.getTime() - token.lastCheckedAt.getTime() : null;
  const stale = checkedAge == null || checkedAge > STALE_MARKET_MS;
  if (stale) missing.push("stale_market_data");
  if (!hasStoredSocials(token.socials)) missing.push("no_socials");
  if (!token.imageUrl) missing.push("no_image");

  const flags: QualityFlag[] = [];
  const breakdown = token.scoreBreakdown;
  if (breakdown) {
    const unknown: ("holders" | "authorities" | "rugcheck")[] = [];
    if (token.topHolderPct == null && breakdown.holders === 5) unknown.push("holders");
    if (token.mintRevoked == null && token.freezeRevoked == null && breakdown.authorities === 5) unknown.push("authorities");
    if (token.rugcheckNormalised == null && breakdown.rugcheck === 4) unknown.push("rugcheck");
    if (unknown.length > 0) flags.push({ code: "safety_unknown_scored_neutral", unknown });
    const raw = rawBreakdownScore(breakdown);
    if (raw >= 100) flags.push({ code: "score_capped", raw });
  }
  if (token.entryAt && token.firstSeenAt) {
    const lateMs = token.entryAt.getTime() - token.firstSeenAt.getTime();
    if (lateMs > LATE_ENTRY_MS) {
      flags.push({
        code: "late_entry",
        minutes: round1(lateMs / 60_000),
        gainVsFirstSeenPct: gainVsFirstSeen(token.entryPriceUsd, token.firstSeenPriceUsd),
      });
    }
  }
  if (isWeakWatchHits(token.promotionHits)) flags.push({ code: "weak_watch_promotion" });
  if (token.lastMcapUsd != null && token.lastMcapUsd > LOW_CAP_BAND_USD) {
    flags.push({ code: "cap_above_low_cap_band", mcapUsd: token.lastMcapUsd });
  }
  if (stale) flags.push({ code: "stale_market_data", ageMinutes: checkedAge == null ? null : round1(checkedAge / 60_000) });
  const unknownEvents = token.unknownEvents ?? 0;
  if (unknownEvents > 0) flags.push({ code: "parse_gap", events: unknownEvents });

  const score = Math.round((100 * (MISSING_LABELS.length - missing.length)) / MISSING_LABELS.length);
  return { score, missing, flags };
}

export function emptyLabelCounts(): Record<MissingLabel, number> {
  return Object.fromEntries(MISSING_LABELS.map((label) => [label, 0])) as Record<MissingLabel, number>;
}

export function emptyFlagCounts(): Record<FlagCode, number> {
  return Object.fromEntries(FLAG_CODES.map((flag) => [flag, 0])) as Record<FlagCode, number>;
}
