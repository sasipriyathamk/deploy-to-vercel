import { resolveGain } from "@/lib/logic/gains";
import { hasBuyPressure, isLifeless, priceCrashed } from "@/lib/logic/funnel";

/** One poll may move the published figure by at most this many points. Larger moves wait for a second reading. */
export const READING_JUMP = 8;

/** A candidate survives a single weak recheck. The next consecutive weak recheck can archive it. */
export const WEAK_RECHECKS_TO_DEMOTE = 2;

/**
 * Low-cap book. Under $1M is still the early trade (a ~$400k name).
 * $1M–$5M matches the middle board. $5M+ has already extended.
 */
export const FRESH_MCAP_USD = 1_000_000;
export const EXTENDED_MCAP_USD = 5_000_000;

export type CapRegime = "fresh" | "mid" | "extended";
export type PathMark = "held" | "soft" | "dumped";
export type CheckpointStage = "t5" | "t15" | "t60";
export type AlertPath = Partial<Record<CheckpointStage, PathMark>>;

export function capRegime(mcapUsd: number | null | undefined): CapRegime | null {
  if (mcapUsd == null || !Number.isFinite(mcapUsd) || mcapUsd <= 0) return null;
  if (mcapUsd < FRESH_MCAP_USD) return "fresh";
  if (mcapUsd < EXTENDED_MCAP_USD) return "mid";
  return "extended";
}

export function pathMark(gainPct: number | null | undefined): PathMark | null {
  if (gainPct == null || !Number.isFinite(gainPct)) return null;
  if (gainPct <= -40) return "dumped";
  if (gainPct < -15) return "soft";
  return "held";
}

/** The first real reading at a checkpoint sticks. Missing prices stay unset. */
export function stampCheckpoint(
  path: AlertPath | null | undefined,
  stage: CheckpointStage,
  gainPct: number | null | undefined,
): AlertPath {
  const current = path ?? {};
  if (current[stage]) return current;
  const mark = pathMark(gainPct);
  if (!mark) return current;
  return { ...current, [stage]: mark };
}

export function smoothReading(
  current: number,
  pending: number | null,
  next: number,
  jump = READING_JUMP,
): { value: number; pending: number | null } {
  if (!Number.isFinite(next)) return { value: current, pending };
  if (!Number.isFinite(current) || Math.abs(next - current) <= jump) {
    return { value: next, pending: null };
  }
  if (pending == null || !Number.isFinite(pending)) return { value: current, pending: next };
  const sameSide = Math.sign(next - current) === Math.sign(pending - current) && Math.sign(next - current) !== 0;
  if (sameSide && Math.abs(next - pending) <= jump) return { value: next, pending: null };
  return { value: current, pending: next };
}

/** The first real score or confidence is published immediately. Later large swings need a second agreeing tick. */
export function publishReading(input: {
  established: boolean;
  current: number;
  pending: number | null;
  next: number;
}): { value: number; pending: number | null } {
  if (!input.established || !Number.isFinite(input.current)) {
    return { value: input.next, pending: null };
  }
  return smoothReading(input.current, input.pending, input.next);
}

export function isWeakTick(input: {
  liqUsd: number | null;
  volH1: number | null;
  buysM5: number | null;
  buysH1: number | null;
}): boolean {
  if (isLifeless(input)) return true;
  if (input.liqUsd == null || input.volH1 == null) return false;
  return input.liqUsd < 300 && input.volH1 < 300;
}

/**
 * A feed that actually shows a ~95% crash and no buy pressure.
 * Missing prices or missing buy counts are not dead-market evidence.
 */
export function isClearDeadMarket(input: {
  priceUsd: number | null;
  mcapUsd: number | null;
  anchorPriceUsd: number | null;
  anchorMcapUsd: number | null;
  buysM5: number | null;
  sellsM5: number | null;
}): boolean {
  const crashed = priceCrashed(input.priceUsd, input.anchorPriceUsd) || priceCrashed(input.mcapUsd, input.anchorMcapUsd);
  if (!crashed || input.buysM5 == null) return false;
  return !hasBuyPressure(input.buysM5, input.sellsM5);
}

export function reviewCandidate(input: {
  weakRechecks: number;
  weak: boolean;
  clearDead: boolean;
  lifeless: boolean;
  timedArchive: { archive: boolean; reason?: "thin_2h" | "drawdown_6h" };
  allowDemote: boolean;
}): { demote: boolean; reason: string | null; weakRechecks: number } {
  const weakRechecks = input.weak ? input.weakRechecks + 1 : 0;
  if (input.clearDead) return { demote: true, reason: "dead_market", weakRechecks };
  if (input.allowDemote && input.timedArchive.archive && input.timedArchive.reason) {
    return { demote: true, reason: input.timedArchive.reason, weakRechecks };
  }
  if (input.allowDemote && input.weak && weakRechecks >= WEAK_RECHECKS_TO_DEMOTE) {
    return { demote: true, reason: input.lifeless ? "stale_1h" : "weak_rechecks", weakRechecks };
  }
  return { demote: false, reason: null, weakRechecks };
}

export type ConfidenceInput = {
  now: Date;
  firstAlertAt: Date | null;
  lastPriceUsd: number | null;
  lastMcapUsd: number | null;
  firstAlertPriceUsd: number | null;
  firstAlertMcapUsd: number | null;
  athPriceUsd: number | null;
  athMcapUsd: number | null;
  liqUsd: number | null;
  volM5: number | null;
  volH1: number | null;
  t5VolM5: number | null;
  topHolderPct: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  rugcheckNormalised: number | null;
  alertPath: AlertPath | null;
};

export type ConfidenceResult = {
  confidence: number;
  regime: CapRegime | null;
  reasons: string[];
  sinceAlertGainPct: number | null;
  athVsAlertPct: number | null;
};

const REGIME_LABEL: Record<CapRegime, string> = {
  fresh: "Fresh cap",
  mid: "Mid cap",
  extended: "Extended cap",
};

function latestCheckpoint(path: AlertPath | null): { stage: CheckpointStage; mark: PathMark } | null {
  if (path?.t60) return { stage: "t60", mark: path.t60 };
  if (path?.t15) return { stage: "t15", mark: path.t15 };
  if (path?.t5) return { stage: "t5", mark: path.t5 };
  return null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Market-quality confidence. Missing provider fields stay neutral. */
export function buildConfidence(input: ConfidenceInput): ConfidenceResult {
  const since = resolveGain({
    lastPrice: input.lastPriceUsd,
    entryPrice: input.firstAlertPriceUsd,
    lastMcap: input.lastMcapUsd,
    entryMcap: input.firstAlertMcapUsd,
  });
  const ath = resolveGain({
    lastPrice: input.athPriceUsd,
    entryPrice: input.firstAlertPriceUsd,
    lastMcap: input.athMcapUsd,
    entryMcap: input.firstAlertMcapUsd,
  });
  const gain = since.gainPct;
  const athGain = ath.gainPct;
  const regime = capRegime(input.lastMcapUsd);
  let value = 50;

  const liq = input.liqUsd;
  if (liq != null) {
    if (liq >= 10_000) value += 8;
    else if (liq >= 3_000) value += 5;
    else if (liq >= 1_000) value += 2;
    else value -= 6;
  }

  const volH1 = input.volH1;
  const volM5 = input.volM5;
  if (volH1 != null || volM5 != null) {
    const rising = volM5 != null && input.t5VolM5 != null && volM5 > input.t5VolM5 && volM5 > 0;
    if ((volH1 ?? 0) >= 25_000) value += 8;
    else if ((volH1 ?? 0) >= 5_000 || rising) value += 5;
    else if ((volH1 ?? 0) > 0 || (volM5 ?? 0) > 0) value += 1;
    else value -= 4;
  }

  const rug = input.rugcheckNormalised;
  if (rug != null && Number.isFinite(rug)) {
    if (rug <= 20) value += 6;
    else if (rug <= 40) value += 4;
    else if (rug > 70) value -= 6;
  }

  const top = input.topHolderPct;
  if (top != null && Number.isFinite(top)) {
    if (top < 30) value += 5;
    else if (top < 50) value += 2;
    else if (top <= 70) value -= 2;
    else value -= 5;
  }

  if (input.mintRevoked === true && input.freezeRevoked === true) value += 3;
  else if (input.mintRevoked === false || input.freezeRevoked === false) value -= 2;

  if (gain != null) {
    if (gain >= 50) value += 8;
    else if (gain >= -15) value += 4;
    else if (gain >= -40) value -= 3;
    else if (gain >= -90) value -= 8;
    else value -= 12;
  }

  if (athGain != null && gain != null && athGain >= 40 && gain <= athGain - 50) value -= 4;

  const checkpoint = latestCheckpoint(input.alertPath);
  if (checkpoint?.mark === "dumped" && checkpoint.stage !== "t5") value -= 4;
  else if (checkpoint?.mark === "held" && checkpoint.stage !== "t5") value += 3;

  if (regime === "extended") value -= 2;

  if (input.firstAlertAt) {
    const minutes = (input.now.getTime() - input.firstAlertAt.getTime()) / 60_000;
    if (minutes >= 15 && minutes <= 24 * 60 && (gain == null || gain > -40)) value += 2;
  }

  const ranked: { text: string; rank: number }[] = [];
  const push = (text: string, rank: number) => ranked.push({ text, rank });

  if (gain != null) {
    if (gain <= -40) push("Dumped since first alert", 1);
    else if (gain < -15) push("Soft since first alert", 3);
    else push("Held up since first alert", 2);
  }
  if (checkpoint?.mark === "dumped") push(`Dumped at ${checkpoint.stage.toUpperCase()}`, 1);
  else if (checkpoint?.mark === "held" && checkpoint.stage !== "t5") {
    push(`Held through ${checkpoint.stage.toUpperCase()}`, 4);
  }
  if (liq != null) {
    if (liq < 1_000) push("Liquidity thin", 2);
    else if (liq >= 3_000) push("Liquidity holding", 5);
  }
  if (volH1 != null || volM5 != null) {
    const faded = (volH1 == null || volH1 < 500) && (volM5 == null || volM5 <= 0);
    const holding = (volH1 != null && volH1 >= 5_000) || (volM5 != null && input.t5VolM5 != null && volM5 >= input.t5VolM5 && volM5 > 0);
    if (faded) push("Volume faded", 2);
    else if (holding) push("Volume holding", 5);
  }
  if (rug == null || !Number.isFinite(rug)) push("RugCheck unknown", 6);
  else if (rug > 70) push("RugCheck elevated", 2);
  else if (rug <= 40) push("RugCheck quiet", 6);
  if (top == null || !Number.isFinite(top)) {
    if (rug != null && Number.isFinite(rug)) push("Holders unknown", 7);
  } else if (top >= 50 || top < 30) push(`Top holder ${Math.round(top)}%`, top >= 50 ? 2 : 6);
  if (regime) push(REGIME_LABEL[regime], regime === "extended" ? 3 : 4);

  ranked.sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text));
  const reasons: string[] = [];
  for (const row of ranked) {
    if (reasons.includes(row.text)) continue;
    reasons.push(row.text);
    if (reasons.length === 4) break;
  }

  return {
    confidence: clampScore(value),
    regime,
    reasons,
    sinceAlertGainPct: gain,
    athVsAlertPct: athGain,
  };
}

export function compareCandidates(
  a: { confidence: number | null; score: number; capRegime: CapRegime | string | null; firstAlertAt: Date | null },
  b: { confidence: number | null; score: number; capRegime: CapRegime | string | null; firstAlertAt: Date | null },
): number {
  const bucket = (regime: string | null) => (regime === "extended" ? 1 : 0);
  const byBucket = bucket(a.capRegime) - bucket(b.capRegime);
  if (byBucket !== 0) return byBucket;
  const byConfidence = (b.confidence ?? -1) - (a.confidence ?? -1);
  if (byConfidence !== 0) return byConfidence;
  if (a.score !== b.score) return b.score - a.score;
  const timeA = a.firstAlertAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const timeB = b.firstAlertAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return timeA - timeB;
}
