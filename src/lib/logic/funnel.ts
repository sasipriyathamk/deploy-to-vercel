import type { TokenSocials } from "@/lib/logic/quality";

export type MarketSnapshot = {
  priceUsd: number | null;
  mcapUsd: number | null;
  liqUsd: number | null;
  volM5: number | null;
  volH1: number | null;
  /** Display-only windows from the same pair payload. The funnel does not read these. */
  volH6: number | null;
  volH24: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  pairCount: number;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  dexId: string | null;
  source: string;
  /** Actual provider retrieval time; cache reads preserve it. */
  observedAt?: string;
  socials?: TokenSocials | null;
};

export type FunnelFlags = Record<string, string | number | boolean | null>;

export type Followup = {
  type: "enrich_t0" | "recheck_t5" | "recheck_t15" | "recheck_t60" | "hold_check";
  delayMs: number;
  retry?: boolean;
};

const MINUTE = 60_000;

export function delayUntil(targetMs: number, now: Date): number {
  return Math.max(0, targetMs - now.getTime());
}

export function stageDelay(firstSeen: Date | null, now: Date, minutes: number): number {
  const base = firstSeen ?? now;
  return delayUntil(base.getTime() + minutes * MINUTE, now);
}

export type T0Decision =
  | { action: "retry"; followups: Followup[] }
  | { action: "reject"; reason: "no_dex_pair"; passed: false }
  | { action: "candidate"; passed: true; followups: Followup[] };

/** Hard-drop only when a confirmed fetch shows zero pairs after one retry. */
export function decideT0(input: {
  pairCount: number;
  retried: boolean;
  firstSeenAt: Date | null;
  now: Date;
}): T0Decision {
  if (input.pairCount > 0) {
    return {
      action: "candidate",
      passed: true,
      followups: [{ type: "recheck_t5", delayMs: stageDelay(input.firstSeenAt, input.now, 5) }],
    };
  }
  if (!input.retried) {
    return {
      action: "retry",
      followups: [{ type: "enrich_t0", delayMs: 2 * MINUTE, retry: true }],
    };
  }
  return { action: "reject", reason: "no_dex_pair", passed: false };
}

export function t5Signals(snap: MarketSnapshot): FunnelFlags {
  const mcap = snap.mcapUsd;
  return {
    liqAtLeast1k: (snap.liqUsd ?? 0) >= 1000,
    buysAtLeast5: (snap.buysM5 ?? 0) >= 5,
    mcapInBand: mcap != null && mcap >= 2_000 && mcap <= 5_000_000,
    pairCount: snap.pairCount,
    liqUsd: snap.liqUsd,
  };
}

export type T5Decision =
  | { action: "retry"; followups: Followup[]; flags: FunnelFlags; passed: false }
  | { action: "archive"; reason: "no_pair_t5"; flags: FunnelFlags; passed: false }
  | { action: "continue"; followups: Followup[]; flags: FunnelFlags; passed: true };

export function decideT5(input: {
  snap: MarketSnapshot;
  retried: boolean;
  firstSeenAt: Date | null;
  now: Date;
}): T5Decision {
  const flags = t5Signals(input.snap);
  if (input.snap.pairCount <= 0) {
    if (!input.retried) {
      return {
        action: "retry",
        passed: false,
        flags,
        followups: [{ type: "recheck_t5", delayMs: 5 * MINUTE, retry: true }],
      };
    }
    return { action: "archive", reason: "no_pair_t5", passed: false, flags };
  }
  return {
    action: "continue",
    passed: true,
    flags,
    followups: [{ type: "recheck_t15", delayMs: stageDelay(input.firstSeenAt, input.now, 15) }],
  };
}

export function priceCrashed(priceUsd: number | null, firstSeenPrice: number | null): boolean {
  if (priceUsd == null || firstSeenPrice == null || firstSeenPrice <= 0) return false;
  return (priceUsd - firstSeenPrice) / firstSeenPrice <= -0.95;
}

/** Any two of the four lenient conditions promotes the token to watching. */
export function t15Hits(input: {
  liqUsd: number | null;
  volH1: number | null;
  volM5: number | null;
  t5VolM5: number | null;
  buysM5: number | null;
  buyersEstimate: number | null;
  priceUsd: number | null;
  firstSeenPrice: number | null;
}): string[] {
  const hits: string[] = [];
  if (input.liqUsd != null && input.liqUsd >= 3_000) hits.push("liq");
  const rising =
    input.volM5 != null && input.t5VolM5 != null && input.volM5 > input.t5VolM5;
  if ((input.volH1 != null && input.volH1 >= 5_000) || rising) hits.push("volume");
  if ((input.buysM5 ?? 0) >= 10 || (input.buyersEstimate ?? 0) >= 10) hits.push("buys");
  if (!priceCrashed(input.priceUsd, input.firstSeenPrice)) hits.push("alive");
  return hits;
}

export function decideT15(input: {
  liqUsd: number | null;
  volH1: number | null;
  volM5: number | null;
  t5VolM5: number | null;
  buysM5: number | null;
  buyersEstimate: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  firstSeenPrice: number | null;
  firstSeenAt: Date | null;
  now: Date;
  alreadyWatching: boolean;
}): {
  promote: boolean;
  hits: string[];
  entryPriceUsd: number | null;
  entryMcapUsd: number | null;
  followups: Followup[];
  passed: boolean;
} {
  const hits = t15Hits(input);
  const promote = hits.length >= 2 && !input.alreadyWatching;
  return {
    promote,
    hits,
    entryPriceUsd: input.priceUsd,
    entryMcapUsd: input.mcapUsd,
    passed: hits.length >= 2,
    followups: [{ type: "recheck_t60", delayMs: stageDelay(input.firstSeenAt, input.now, 60) }],
  };
}

export function isLifeless(input: {
  liqUsd: number | null;
  volH1: number | null;
  buysM5: number | null;
  buysH1: number | null;
}): boolean {
  if (input.liqUsd == null || input.volH1 == null) return false;
  if (input.liqUsd >= 500 || input.volH1 >= 500) return false;
  return (input.buysM5 ?? 0) + (input.buysH1 ?? 0) === 0;
}

export function hasBuyPressure(buys: number | null, sells: number | null): boolean {
  if (buys == null || buys <= 0) return false;
  return buys >= (sells ?? 0);
}

export function nextWeakSince(
  current: Date | null,
  liqUsd: number | null,
  volH1: number | null,
  now: Date,
): Date | null {
  if (liqUsd == null || volH1 == null) return current;
  const weak = liqUsd < 300 && volH1 < 300;
  if (!weak) return null;
  return current ?? now;
}

export function decideArchive(input: {
  status: string;
  now: Date;
  weakSince: Date | null;
  liqUsd: number | null;
  volH1: number | null;
  entryAt: Date | null;
  gainPct: number | null;
  buysM5: number | null;
  sellsM5: number | null;
}): { archive: boolean; reason?: "thin_2h" | "drawdown_6h" } {
  if (input.status !== "watching" && input.status !== "candidate") return { archive: false };
  const ageEntry = input.entryAt ? input.now.getTime() - input.entryAt.getTime() : 0;
  const noPressure = input.buysM5 != null && !hasBuyPressure(input.buysM5, input.sellsM5);
  if (ageEntry >= 6 * 60 * MINUTE && input.gainPct != null && input.gainPct <= -90 && noPressure) {
    return { archive: true, reason: "drawdown_6h" };
  }
  const weakFor = input.weakSince ? input.now.getTime() - input.weakSince.getTime() : 0;
  const stillThin =
    input.liqUsd != null && input.volH1 != null && input.liqUsd < 300 && input.volH1 < 300;
  if (input.weakSince && weakFor >= 2 * 60 * MINUTE && stillThin) {
    return { archive: true, reason: "thin_2h" };
  }
  return { archive: false };
}

export function shouldRevive(volH1: number | null, liqUsd: number | null): boolean {
  return (volH1 != null && volH1 >= 5_000) || (liqUsd != null && liqUsd >= 5_000);
}
