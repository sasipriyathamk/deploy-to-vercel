import { describe, expect, it } from "vitest";
import { compactUsd, entrySummary, fmtAge, fmtSolSpent, fmtStamp, fmtTime, formatFlagValue } from "@/lib/format";
import { presentBuy } from "@/lib/present";

describe("USD display", () => {
  it("uses dollars, thousands separators, and compact thousands", () => {
    expect(compactUsd(1280)).toBe("$1,280");
    expect(compactUsd(1280.4)).toBe("$1,280.40");
    expect(compactUsd(12800)).toBe("$12.80k");
    expect(compactUsd(14209)).toBe("$14.21k");
    expect(compactUsd(37333)).toBe("$37.33k");
    expect(compactUsd(229891)).toBe("$229.89k");
    expect(compactUsd(1_529_996)).toBe("$1.53M");
    expect(compactUsd(508.24)).toBe("$508.24");
    expect(compactUsd(10.14)).toBe("$10.14");
  });

  it("keeps sub-cent prices in dollars instead of scientific notation", () => {
    expect(compactUsd(0.00153)).toBe("$0.00153");
    expect(compactUsd(0.00003919)).toBe("$0.00003919");
    expect(compactUsd(0.00001478)).toBe("$0.00001478");
    expect(compactUsd(0.25)).toBe("$0.25");
    expect(compactUsd(0)).toBe("$0.00");
    for (const value of [0.00003919, 0.00001478, 1e-8, 12800]) {
      expect(compactUsd(value)).not.toMatch(/e[+-]/i);
      expect(compactUsd(value).startsWith("$") || compactUsd(value).startsWith("-$")).toBe(true);
    }
  });

  it("does not turn a missing figure into zero", () => {
    expect(compactUsd(null)).toBe("—");
    expect(compactUsd(undefined)).toBe("—");
    expect(compactUsd(Number.NaN)).toBe("—");
  });
});

describe("IST timestamps", () => {
  it("renders Asia/Calcutta with an IST label", () => {
    expect(fmtTime("2026-11-09T23:20:06.000Z")).toBe("10 Nov 2026, 04:50 IST");
    expect(fmtTime(new Date("2026-11-10T01:50:15.577Z"))).toBe("10 Nov 2026, 07:20 IST");
  });

  it("says missing for unknown times", () => {
    expect(fmtTime(null)).toBe("missing");
    expect(fmtTime("")).toBe("missing");
    expect(fmtTime("not-a-date")).toBe("missing");
    expect(fmtAge(null)).toBe("missing");
    expect(fmtStamp(undefined)).toBe("missing");
  });

  it("pairs a clock time with age when both exist", () => {
    const stamp = fmtStamp("2026-11-09T23:20:06.000Z", Date.parse("2026-11-10T01:20:06.000Z"));
    expect(stamp).toBe("10 Nov 2026, 04:50 IST (2h)");
  });
});

describe("entry display", () => {
  it("shows price, mcap, and IST time when an entry was stamped", () => {
    expect(
      entrySummary({
        entryAt: "2026-11-10T01:50:15.553Z",
        entryPriceUsd: 0.00001478,
        entryMcapUsd: 14209,
      }),
    ).toBe("$0.00001478 · mcap $14.21k · 10 Nov 2026, 07:20 IST");
  });

  it("keeps a partial entry visible instead of hiding it", () => {
    expect(
      entrySummary({
        entryAt: "2026-11-10T01:50:15.577Z",
        entryPriceUsd: 508.24,
        entryMcapUsd: null,
      }),
    ).toBe("$508.24 · mcap missing · 10 Nov 2026, 07:20 IST");
  });

  it("does not invent an entry", () => {
    expect(entrySummary({ entryAt: null, entryPriceUsd: 1, entryMcapUsd: 2 })).toBe("No entry yet");
    expect(entrySummary({ entryAt: "bogus", entryPriceUsd: 1, entryMcapUsd: 2 })).toBe("Entry time missing");
  });
});

describe("other figures", () => {
  it("labels SOL spent separately from USD prices", () => {
    expect(fmtSolSpent(-0.36892234)).toBe("0.369 SOL spent");
    expect(fmtSolSpent(null)).toBe("SOL spent missing");
  });

  it("formats money flags as USD and leaves scores alone", () => {
    expect(formatFlagValue("liqUsd", 229891)).toBe("$229.89k");
    expect(formatFlagValue("priceUsd", 0.00003919)).toBe("$0.00003919");
    expect(formatFlagValue("pairCount", 1)).toBe("1");
    expect(formatFlagValue("liqUsd", null)).toBe("missing");
  });
});

describe("tape presentation", () => {
  it("carries entry and USD quote fields onto buys", () => {
    const buy = presentBuy({
      signature: "sig",
      wallet: "wallet",
      side: "buy",
      sol_delta: -0.0629,
      block_time: "2026-11-09T23:31:38.000Z",
      entry_at: "2026-11-10T01:50:20.080Z",
      entry_price_usd: "0.00003919",
      entry_mcap_usd: 37333,
      last_price_usd: 0.00003919,
      last_mcap_usd: 37333,
    });
    expect(buy.entryAt).toBe("2026-11-10T01:50:20.080Z");
    expect(buy.entryPriceUsd).toBe(0.00003919);
    expect(buy.entryMcapUsd).toBe(37333);
    expect(buy.lastPriceUsd).toBe(0.00003919);
    expect(buy.lastMcapUsd).toBe(37333);
    expect(buy.blockTime).toBe("2026-11-09T23:31:38.000Z");
  });
});
