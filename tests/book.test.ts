import { describe, expect, it } from "vitest";
import { matchesBookQuery, nextSort, observedMcap, rankByGain, sortBook, sparklineSeries, volumeForWindow, type BookToken } from "@/lib/logic/book";

function token(patch: Partial<BookToken> & Pick<BookToken, "mint">): BookToken {
  return {
    symbol: null,
    name: null,
    gainPct: null,
    athGainPct: null,
    lastMcapUsd: null,
    lastVolH1: null,
    ageAnchor: null,
    confidence: null,
    capRegime: null,
    entryMcapUsd: null,
    firstAlertMcapUsd: null,
    ...patch,
  };
}

describe("book ordering", () => {
  it("sorts latest by discovery, not entry time, with unknown timestamps last", () => {
    const rows = [
      token({mint:"older",firstSeenAt:"2026-11-10T10:00:00Z",ageAnchor:"2026-11-12T10:00:00Z"}),
      token({mint:"unknown",firstSeenAt:null}),
      token({mint:"newest",firstSeenAt:"2026-11-12T09:00:00Z",ageAnchor:"2026-11-09T10:00:00Z"}),
      token({mint:"invalid",firstSeenAt:"invalid"}),
    ];
    expect(nextSort(null,"latest")).toEqual({key:"latest",direction:"desc"});
    expect(sortBook(rows,{key:"latest",direction:"desc"},()=>null).map(t=>t.mint)).toEqual(["newest","older","unknown","invalid"]);
    expect(sortBook(rows,{key:"latest",direction:"asc"},()=>null)[0].mint).toBe("older");
  });
  it("ranks the tracked set by current gain", () => {
    const ranked = rankByGain([
      token({ mint: "b", gainPct: 10 }),
      token({ mint: "c", gainPct: null }),
      token({ mint: "a", gainPct: 50 }),
      token({ mint: "d", gainPct: 50 }),
    ]);
    expect(ranked.map((row: BookToken) => row.mint)).toEqual(["a", "d", "b"]);
  });

  it("keeps server order until a sort is chosen, and never sorts on data quality", () => {
    const rows = [
      { ...token({ mint: "low", gainPct: 1 }), dataQuality: { score: 10, missing: ["x"] } },
      { ...token({ mint: "high", gainPct: 9 }), dataQuality: { score: 99, missing: [] } },
    ];
    expect(sortBook(rows, null, () => null).map((row) => row.mint)).toEqual(["low", "high"]);
    expect(sortBook(rows, { key: "gain", direction: "desc" }, () => null).map((row) => row.mint)).toEqual([
      "high",
      "low",
    ]);
  });

  it("puts missing 24h volume last", () => {
    const rows = [token({ mint: "none" }), token({ mint: "big" }), token({ mint: "small" })];
    const volumes = new Map([["big", 80], ["small", 5]]);
    const sorted = sortBook(rows, { key: "volH24", direction: "desc" }, (row) => volumes.get(row.mint) ?? null);
    expect(sorted.map((row) => row.mint)).toEqual(["big", "small", "none"]);
  });

  it("toggles sort direction from the natural order", () => {
    expect(nextSort(null, "age")).toEqual({ key: "age", direction: "asc" });
    expect(nextSort({ key: "gain", direction: "desc" }, "gain")).toEqual({ key: "gain", direction: "asc" });
  });

  it("prefers entry market cap, then the first alert", () => {
    expect(observedMcap({ entryMcapUsd: 12, firstAlertMcapUsd: 4 })).toEqual({ value: 12, source: "entry" });
    expect(observedMcap({ entryMcapUsd: null, firstAlertMcapUsd: 4 })).toEqual({ value: 4, source: "alert" });
    expect(observedMcap({ entryMcapUsd: null, firstAlertMcapUsd: null }).value).toBeNull();
  });

  it("uses stored 1h volume and only the display payload for 6h and 24h", () => {
    const display = { volH1: 9, volH6: 20, volH24: 40 };
    expect(volumeForWindow("h1", 3, display)).toBe(3);
    expect(volumeForWindow("h1", null, display)).toBe(9);
    expect(volumeForWindow("h6", 3, display)).toBe(20);
    expect(volumeForWindow("h24", 3, undefined)).toBeNull();
  });

  it("matches mint, symbol, or name", () => {
    const row = token({ mint: "MintABC", symbol: "KEEL", name: "Keel Cat" });
    expect(matchesBookQuery(row, " keel ")).toBe(true);
    expect(matchesBookQuery(row, "abc")).toBe(true);
    expect(matchesBookQuery(row, "nope")).toBe(false);
  });

  it("builds a sparkline only when two prices exist", () => {
    expect(
      sparklineSeries([
        { at: "2026-11-10T00:00:00Z", price: 1 },
        { at: "2026-11-10T01:00:00Z", price: null },
        { at: "2026-11-10T02:00:00Z", price: 2 },
      ]),
    ).toEqual([1, 2]);
    expect(sparklineSeries([{ at: "2026-11-10T00:00:00Z", price: 1 }])).toEqual([]);
  });
});
