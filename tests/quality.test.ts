import { describe, expect, it } from "vitest";
import { buildDataQuality, type QualityToken } from "@/lib/logic/quality";
import { scoreToken, type ScoreBreakdown } from "@/lib/logic/score";

const now = new Date("2026-11-10T12:00:00.000Z");
const seen = new Date("2026-11-10T11:40:00.000Z");
const recent = new Date("2026-11-10T11:50:00.000Z");

function breakdown(overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    base: 50,
    liquidity: 5,
    volume: 0,
    buyPressure: 0,
    holders: 10,
    authorities: 10,
    rugcheck: 7,
    sniperHold: 5,
    age: 3,
    venue: 2,
    drawdown: 0,
    total: 100,
    ...overrides,
  };
}

function token(overrides: Partial<QualityToken> = {}): QualityToken {
  return {
    pairCount: 1,
    lastMcapUsd: 20_000,
    lastLiqUsd: 4_000,
    topHolderPct: 12,
    rugcheckNormalised: 30,
    mintRevoked: true,
    freezeRevoked: true,
    sniperBuyTx: "sig",
    entryAt: recent,
    entryPriceUsd: 0.01,
    firstAlertAt: seen,
    firstSeenAt: seen,
    firstSeenPriceUsd: 0.01,
    lastCheckedAt: now,
    imageUrl: "https://cdn.example/token.png",
    socials: { website: "https://example.com", twitter: null, telegram: null },
    scoreBreakdown: breakdown(),
    promotionHits: "liq,volume",
    unknownEvents: 0,
    ...overrides,
  };
}

describe("diagnostic data quality", () => {
  it("scores a complete fresh token at 100 with no flags", () => {
    const quality = buildDataQuality(token(), now);
    expect(quality.score).toBe(100);
    expect(quality.missing).toEqual([]);
    expect(quality.flags).toEqual([]);
  });

  it("lists missing inputs and the misleading flags without changing the trade score", () => {
    const judged = scoreToken({
      liqUsd: 4_000,
      volM5: 1,
      volH1: 1,
      buysM5: 1,
      sellsM5: 1,
      buysH1: 1,
      sellsH1: 1,
      topHolderPct: null,
      mintRevoked: null,
      freezeRevoked: null,
      rugcheckNormalised: null,
      sniperHolding: null,
      entryAt: null,
      now,
      venue: null,
      graduated: false,
      lastPriceUsd: null,
      athPriceUsd: null,
    });
    const again = scoreToken({
      liqUsd: 4_000,
      volM5: 1,
      volH1: 1,
      buysM5: 1,
      sellsM5: 1,
      buysH1: 1,
      sellsH1: 1,
      topHolderPct: null,
      mintRevoked: null,
      freezeRevoked: null,
      rugcheckNormalised: null,
      sniperHolding: null,
      entryAt: null,
      now,
      venue: null,
      graduated: false,
      lastPriceUsd: null,
      athPriceUsd: null,
    });
    expect(again).toEqual(judged);
    const capped = breakdown({
      liquidity: 15,
      volume: 15,
      buyPressure: 10,
      holders: 5,
      authorities: 5,
      rugcheck: 4,
      sniperHold: 10,
      age: 10,
      venue: 5,
    });
    const quality = buildDataQuality(
      token({
        pairCount: 0,
        lastMcapUsd: 6_000_000,
        lastLiqUsd: null,
        topHolderPct: null,
        rugcheckNormalised: null,
        mintRevoked: null,
        freezeRevoked: null,
        sniperBuyTx: null,
        entryAt: new Date(seen.getTime() + 20 * 60_000),
        entryPriceUsd: 0.02,
        firstAlertAt: null,
        lastCheckedAt: new Date(now.getTime() - 31 * 60_000),
        imageUrl: null,
        socials: null,
        scoreBreakdown: capped,
        promotionHits: "alive,liq",
        unknownEvents: 4,
      }),
      now,
    );
    expect(quality.missing).toEqual([
      "no_dex_pair",
      "no_liquidity",
      "no_holders",
      "no_rugcheck",
      "no_authorities",
      "parse_failed",
      "no_first_alert",
      "stale_market_data",
      "no_socials",
      "no_image",
    ]);
    expect(quality.score).toBe(Math.round((100 * 2) / 12));
    expect(quality.flags).toEqual(
      expect.arrayContaining([
        { code: "safety_unknown_scored_neutral", unknown: ["holders", "authorities", "rugcheck"] },
        { code: "late_entry", minutes: 20, gainVsFirstSeenPct: 100 },
        { code: "score_capped", raw: 129 },
        { code: "weak_watch_promotion" },
        { code: "cap_above_low_cap_band", mcapUsd: 6_000_000 },
        { code: "stale_market_data", ageMinutes: 31 },
        { code: "parse_gap", events: 4 },
      ]),
    );
    expect(judged.total).toBeLessThanOrEqual(100);
    expect(judged.holders).toBe(5);
    expect(judged.authorities).toBe(5);
    expect(judged.rugcheck).toBe(4);
  });
});