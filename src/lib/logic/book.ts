import type { CapRegime } from "@/lib/logic/confidence";
import type { SafetyTone } from "@/lib/logic/safety";

export type VolumeWindow = "h1" | "h6" | "h24";

export type SortKey = "latest" | "gain" | "ath" | "mc" | "volH1" | "volH24" | "age" | "confidence";

export type SortState = { key: SortKey; direction: "asc" | "desc" } | null;

export type BookToken = {
  mint: string;
  symbol: string | null;
  name: string | null;
  gainPct: number | null;
  athGainPct: number | null;
  lastMcapUsd: number | null;
  lastVolH1: number | null;
  ageAnchor: string | null;
  firstSeenAt?: string | null;
  confidence: number | null;
  capRegime: CapRegime | null;
  entryMcapUsd: number | null;
  firstAlertMcapUsd: number | null;
};

export type RegimeFilter = "all" | CapRegime | "unset";
export type SafetyFilter = "all" | SafetyTone;

const NATURAL_DIRECTION: Record<SortKey, "asc" | "desc"> = {
  latest: "desc",
  gain: "desc",
  ath: "desc",
  mc: "desc",
  volH1: "desc",
  volH24: "desc",
  age: "asc",
  confidence: "desc",
};

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current?.key !== key) return { key, direction: NATURAL_DIRECTION[key] };
  return { key, direction: current.direction === "desc" ? "asc" : "desc" };
}

export const WINDOW_LABEL: Record<VolumeWindow, string> = { h1: "1h", h6: "6h", h24: "24h" };

export function volumeForWindow(
  window: VolumeWindow,
  storedH1: number | null,
  display: { volH1: number | null; volH6: number | null; volH24: number | null } | undefined,
): number | null {
  if (window === "h1") return storedH1 ?? display?.volH1 ?? null;
  if (window === "h6") return display?.volH6 ?? null;
  return display?.volH24 ?? null;
}

export function rankByGain<T extends { mint: string; gainPct: number | null }>(tokens: T[], limit = 12): T[] {
  return tokens
    .filter((token) => token.gainPct != null && Number.isFinite(token.gainPct))
    .sort((left, right) => (right.gainPct ?? 0) - (left.gainPct ?? 0) || left.mint.localeCompare(right.mint))
    .slice(0, limit);
}

export function observedMcap(token: { entryMcapUsd: number | null; firstAlertMcapUsd: number | null }): {
  value: number | null;
  source: "entry" | "alert" | null;
} {
  if (token.entryMcapUsd != null && Number.isFinite(token.entryMcapUsd)) {
    return { value: token.entryMcapUsd, source: "entry" };
  }
  if (token.firstAlertMcapUsd != null && Number.isFinite(token.firstAlertMcapUsd)) {
    return { value: token.firstAlertMcapUsd, source: "alert" };
  }
  return { value: null, source: null };
}

export function matchesBookQuery(token: { mint: string; symbol: string | null; name: string | null }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [token.mint, token.symbol ?? "", token.name ?? ""].some((value) => value.toLowerCase().includes(needle));
}

export function sortBook<T extends BookToken>(
  tokens: readonly T[],
  sort: SortState,
  volume24: (token: T) => number | null,
  now = Date.now(),
): T[] {
  if (!sort) return [...tokens];
  const direction = sort.direction === "asc" ? 1 : -1;
  const metric = (token: T): number | null => {
    switch (sort.key) {
      case "latest": {
        const time = token.firstSeenAt ? new Date(token.firstSeenAt).getTime() : NaN;
        return Number.isFinite(time) ? time : null;
      }
      case "gain":
        return token.gainPct;
      case "ath":
        return token.athGainPct;
      case "mc":
        return token.lastMcapUsd;
      case "volH1":
        return token.lastVolH1;
      case "volH24":
        return volume24(token);
      case "confidence":
        return token.confidence;
      case "age": {
        if (!token.ageAnchor) return null;
        const time = new Date(token.ageAnchor).getTime();
        if (Number.isNaN(time)) return null;
        return Math.max(0, now - time);
      }
      default:
        return null;
    }
  };
  return tokens
    .map((token, index) => ({ token, index, value: metric(token) }))
    .sort((left, right) => {
      if (left.value == null && right.value == null) return left.index - right.index;
      if (left.value == null) return 1;
      if (right.value == null) return -1;
      if (left.value === right.value) return left.index - right.index;
      return left.value < right.value ? -direction : direction;
    })
    .map((row) => row.token);
}

export type PriceAnchor = { at: string | null; price: number | null };

export function sparklineSeries(anchors: PriceAnchor[]): number[] {
  const points: { t: number; p: number }[] = [];
  for (const anchor of anchors) {
    if (!anchor.at || anchor.price == null || !Number.isFinite(anchor.price) || anchor.price <= 0) continue;
    const time = new Date(anchor.at).getTime();
    if (Number.isNaN(time)) continue;
    points.push({ t: time, p: anchor.price });
  }
  points.sort((left, right) => left.t - right.t);
  const series: number[] = [];
  for (const point of points) {
    if (series.length === 0 || series[series.length - 1] !== point.p) series.push(point.p);
  }
  return series.length >= 2 ? series : [];
}
