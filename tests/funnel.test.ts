import { describe, expect, it } from "vitest";
import { decideArchive, decideT0, decideT15, decideT5, isLifeless, shouldRevive, t15Hits } from "@/lib/logic/funnel";
import type { MarketSnapshot } from "@/lib/logic/funnel";

const now = new Date("2026-11-09T12:00:00Z");
const seen = new Date("2026-11-09T11:00:00Z");

function snap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    priceUsd: 0.01,
    mcapUsd: 20_000,
    liqUsd: 4_000,
    volM5: 800,
    volH1: 6_000,
    volH6: null,
    volH24: null,
    buysM5: 12,
    sellsM5: 4,
    buysH1: 40,
    sellsH1: 10,
    pairCount: 1,
    symbol: "MEME",
    name: "Meme",
    imageUrl: null,
    dexId: "pumpfun",
    source: "dexscreener",
    socials: null,
    ...overrides,
  };
}

describe("lenient funnel", () => {
  it("retries a missing pair once, then hard-drops", () => {
    expect(decideT0({ pairCount: 0, retried: false, firstSeenAt: seen, now }).action).toBe("retry");
    expect(decideT0({ pairCount: 0, retried: true, firstSeenAt: seen, now })).toMatchObject({
      action: "reject",
      reason: "no_dex_pair",
    });
    expect(decideT0({ pairCount: 1, retried: false, firstSeenAt: seen, now }).action).toBe("candidate");
  });

  it("archives a disappeared pair at T5 only after a retry", () => {
    const empty = snap({ pairCount: 0, liqUsd: 0, priceUsd: null });
    expect(decideT5({ snap: empty, retried: false, firstSeenAt: seen, now }).action).toBe("retry");
    expect(decideT5({ snap: empty, retried: true, firstSeenAt: seen, now }).action).toBe("archive");
    expect(decideT5({ snap: snap({ liqUsd: 0 }), retried: false, firstSeenAt: seen, now }).action).toBe("continue");
  });

  it("promotes on any two T15 signals and uses the live price as entry", () => {
    const pass = decideT15({
      liqUsd: 4_000,
      volH1: 1_000,
      volM5: 10,
      t5VolM5: 100,
      buysM5: 1,
      buyersEstimate: 1,
      priceUsd: 0.2,
      mcapUsd: 40_000,
      firstSeenPrice: 0.05,
      firstSeenAt: seen,
      now,
      alreadyWatching: false,
    });
    expect(pass.promote).toBe(true);
    expect(pass.entryPriceUsd).toBe(0.2);
    expect(pass.hits).toEqual(expect.arrayContaining(["liq", "alive"]));

    const fail = t15Hits({
      liqUsd: 100,
      volH1: 10,
      volM5: 1,
      t5VolM5: 5,
      buysM5: 1,
      buyersEstimate: 1,
      priceUsd: 0.001,
      firstSeenPrice: 0.05,
    });
    expect(fail).toEqual([]);
  });

  it("archives lifeless hour-old markets and revives liquid ones", () => {
    expect(isLifeless({ liqUsd: 100, volH1: 50, buysM5: 0, buysH1: 0 })).toBe(true);
    expect(isLifeless({ liqUsd: null, volH1: 0, buysM5: 0, buysH1: 0 })).toBe(false);
    expect(shouldRevive(6_000, 100)).toBe(true);
    expect(shouldRevive(100, 1_000)).toBe(false);
    const weakSince = new Date(now.getTime() - 3 * 60 * 60_000);
    expect(
      decideArchive({
        status: "watching",
        now,
        weakSince,
        liqUsd: 100,
        volH1: 100,
        entryAt: seen,
        gainPct: -10,
        buysM5: 2,
        sellsM5: 1,
      }).reason,
    ).toBe("thin_2h");
  });
});
