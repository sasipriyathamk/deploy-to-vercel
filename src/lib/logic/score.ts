import { drawdownFromAthPct } from "@/lib/logic/gains";

export const INTERESTING_SCORE = 60;

export type ScoreInput = {
  liqUsd: number | null;
  volM5: number | null;
  volH1: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  topHolderPct: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  rugcheckNormalised: number | null;
  sniperHolding: boolean | null;
  entryAt: Date | null;
  now: Date;
  venue: string | null;
  graduated: boolean;
  lastPriceUsd: number | null;
  athPriceUsd: number | null;
};

export type ScoreBreakdown = {
  base: 50;
  liquidity: number;
  volume: number;
  buyPressure: number;
  holders: number;
  authorities: number;
  rugcheck: number;
  sniperHold: number;
  age: number;
  venue: number;
  drawdown: number;
  total: number;
};

export const SCORE_FACTORS: { key: keyof Omit<ScoreBreakdown, "base" | "total">; label: string }[] = [
  { key: "liquidity", label: "Liquidity" },
  { key: "volume", label: "Volume" },
  { key: "buyPressure", label: "Buy pressure" },
  { key: "holders", label: "Holders" },
  { key: "authorities", label: "Authorities" },
  { key: "rugcheck", label: "RugCheck" },
  { key: "sniperHold", label: "Sniper hold" },
  { key: "age", label: "Age" },
  { key: "venue", label: "Venue" },
  { key: "drawdown", label: "Drawdown" },
];

function liquidityPoints(liq: number | null): number {
  if (liq == null || liq < 1000) return 0;
  if (liq < 3000) return 5;
  if (liq < 10000) return 10;
  return 15;
}

function volumePoints(volM5: number | null, volH1: number | null): number {
  if (volH1 != null && volH1 >= 25_000) return 15;
  if (volH1 != null && volH1 >= 5_000) return 10;
  if (volM5 != null && volM5 > 0) return 5;
  return 0;
}

function pressurePoints(
  buysM5: number | null,
  sellsM5: number | null,
  buysH1: number | null,
  sellsH1: number | null,
): number {
  const buys = buysM5 ?? buysH1;
  const sells = buysM5 != null ? sellsM5 : sellsH1;
  if (buys == null) return 0;
  const other = sells ?? 0;
  if (other === 0) return buys > 0 ? 10 : 0;
  if (buys >= other * 1.5) return 10;
  if (buys >= other) return 5;
  return 0;
}

function holderPoints(pct: number | null): number {
  if (pct == null) return 5;
  if (pct < 30) return 10;
  if (pct > 70) return 1;
  if (pct > 50) return 2;
  return 6;
}

function authorityPoints(mintRevoked: boolean | null, freezeRevoked: boolean | null): number {
  if (mintRevoked == null && freezeRevoked == null) return 5;
  const mint = mintRevoked === true;
  const freeze = freezeRevoked === true;
  if (mint && freeze) return 10;
  if (mint || freeze) return 5;
  return 2;
}

/** RugCheck normalised score is treated as risk (higher = riskier) and mapped gently. */
function rugPoints(normalised: number | null): number {
  if (normalised == null || !Number.isFinite(normalised)) return 4;
  if (normalised <= 20) return 10;
  if (normalised <= 40) return 7;
  if (normalised <= 60) return 5;
  if (normalised <= 80) return 3;
  return 1;
}

function holdPoints(holding: boolean | null): number {
  if (holding === true) return 10;
  if (holding === false) return 2;
  return 5;
}

function agePoints(entryAt: Date | null, now: Date): number {
  if (!entryAt) return 3;
  const minutes = (now.getTime() - entryAt.getTime()) / 60_000;
  if (minutes < 15) return 3;
  if (minutes <= 60) return 6;
  return 10;
}

function venuePoints(venue: string | null, graduated: boolean): number {
  const name = (venue ?? "").toLowerCase();
  if (
    graduated ||
    name.includes("raydium") ||
    name.includes("meteora") ||
    name.includes("orca") ||
    name.includes("pump.amm") ||
    name.includes("pumpswap")
  ) {
    return 5;
  }
  if (name.includes("jupiter")) return 3;
  return 2;
}

function drawdownPoints(last: number | null, ath: number | null): number {
  const dd = drawdownFromAthPct(last, ath);
  if (dd == null) return 0;
  if (dd <= -80) return -10;
  if (dd <= -50) return -4;
  if (dd <= -30) return -2;
  return 0;
}

export function scoreToken(input: ScoreInput): ScoreBreakdown {
  const breakdown: ScoreBreakdown = {
    base: 50,
    liquidity: liquidityPoints(input.liqUsd),
    volume: volumePoints(input.volM5, input.volH1),
    buyPressure: pressurePoints(input.buysM5, input.sellsM5, input.buysH1, input.sellsH1),
    holders: holderPoints(input.topHolderPct),
    authorities: authorityPoints(input.mintRevoked, input.freezeRevoked),
    rugcheck: rugPoints(input.rugcheckNormalised),
    sniperHold: holdPoints(input.sniperHolding),
    age: agePoints(input.entryAt, input.now),
    venue: venuePoints(input.venue, input.graduated),
    drawdown: drawdownPoints(input.lastPriceUsd, input.athPriceUsd),
    total: 0,
  };
  const sum =
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
    breakdown.drawdown;
  breakdown.total = Math.max(0, Math.min(100, Math.round(sum)));
  return breakdown;
}
