import { describe, expect, it } from "vitest";
import { resolveGain, updateAth } from "@/lib/logic/gains";

describe("gain and ATH", () => {
  it("computes gain from entry, not from the sniper price", () => {
    const gain = resolveGain({
      lastPrice: 0.03,
      entryPrice: 0.02,
      lastMcap: 30_000,
      entryMcap: 10_000,
    });
    expect(gain).toEqual({ gainPct: 50, basis: "price" });
  });

  it("labels mcap gain when price is missing", () => {
    const gain = resolveGain({
      lastPrice: null,
      entryPrice: null,
      lastMcap: 15_000,
      entryMcap: 10_000,
    });
    expect(gain).toEqual({ gainPct: 50, basis: "mcap" });
  });

  it("tracks the high since entry and ignores earlier prints", () => {
    const entryAt = new Date("2026-11-09T12:00:00Z");
    const ignored = updateAth({
      entryAt,
      entryPriceUsd: 1,
      entryMcapUsd: 100,
      athPriceUsd: 1,
      athMcapUsd: 100,
      athAt: entryAt,
      priceUsd: 5,
      mcapUsd: 500,
      observedAt: new Date("2026-11-09T11:00:00Z"),
    });
    expect(ignored.athPriceUsd).toBe(1);
    expect(ignored.athGainPct).toBe(0);

    const raised = updateAth({
      ...ignored,
      entryAt,
      entryPriceUsd: 1,
      entryMcapUsd: 100,
      priceUsd: 1.5,
      mcapUsd: 140,
      observedAt: new Date("2026-11-09T12:30:00Z"),
    });
    expect(raised.athPriceUsd).toBe(1.5);
    expect(raised.athGainPct).toBe(50);

    const pulledBack = updateAth({
      ...raised,
      entryAt,
      entryPriceUsd: 1,
      entryMcapUsd: 100,
      priceUsd: 1.2,
      mcapUsd: 110,
      observedAt: new Date("2026-11-09T13:00:00Z"),
    });
    expect(pulledBack.athPriceUsd).toBe(1.5);
    expect(pulledBack.athGainPct).toBe(50);
    const live = resolveGain({ lastPrice: 1.2, entryPrice: 1, lastMcap: 110, entryMcap: 100 });
    expect(live.gainPct).toBeCloseTo(20);
  });

  it("returns null when entry price is zero", () => {
    expect(resolveGain({ lastPrice: 1, entryPrice: 0, lastMcap: null, entryMcap: null })).toEqual({
      gainPct: null,
      basis: null,
    });
  });
});
