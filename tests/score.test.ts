import { describe, expect, it } from "vitest";
import { scoreToken } from "@/lib/logic/score";

const now = new Date("2026-11-09T12:00:00Z");

describe("lenient score", () => {
  it("starts at 50 and gives unknown data the benefit of the doubt", () => {
    const score = scoreToken({
      liqUsd: null,
      volM5: null,
      volH1: null,
      buysM5: null,
      sellsM5: null,
      buysH1: null,
      sellsH1: null,
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
    expect(score.base).toBe(50);
    expect(score.holders).toBe(5);
    expect(score.rugcheck).toBe(4);
    expect(score.sniperHold).toBe(5);
    expect(score.total).toBe(74);
  });

  it("clamps to 0-100 and punishes an 80% drawdown", () => {
    const high = scoreToken({
      liqUsd: 50_000,
      volM5: 1_000,
      volH1: 40_000,
      buysM5: 30,
      sellsM5: 5,
      buysH1: 80,
      sellsH1: 10,
      topHolderPct: 10,
      mintRevoked: true,
      freezeRevoked: true,
      rugcheckNormalised: 5,
      sniperHolding: true,
      entryAt: new Date(now.getTime() - 2 * 60 * 60_000),
      now,
      venue: "raydium",
      graduated: true,
      lastPriceUsd: 2,
      athPriceUsd: 2,
    });
    expect(high.total).toBe(100);

    const dumped = scoreToken({
      ...{
        liqUsd: 0,
        volM5: 0,
        volH1: 0,
        buysM5: 0,
        sellsM5: 10,
        buysH1: 0,
        sellsH1: 10,
        topHolderPct: 90,
        mintRevoked: false,
        freezeRevoked: false,
        rugcheckNormalised: 95,
        sniperHolding: false,
        entryAt: now,
        now,
        venue: "pump.fun",
        graduated: false,
        lastPriceUsd: 0.1,
        athPriceUsd: 1,
      },
    });
    expect(dumped.drawdown).toBe(-10);
    expect(dumped.total).toBeGreaterThanOrEqual(0);
    expect(dumped.total).toBeLessThanOrEqual(100);
  });
});
