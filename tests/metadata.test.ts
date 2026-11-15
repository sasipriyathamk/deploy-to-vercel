import { describe, expect, it } from "vitest";
import { snapshotFromPairs } from "@/lib/market";
import {
  fillMissingText,
  gmgnTokenUrl,
  missingMetadata,
  tokenSubtitle,
  tokenTitle,
} from "@/lib/logic/metadata";

const MINT = "Mint111111111111111111111111111111111111111";

describe("token metadata", () => {
  it("keeps price on the deepest base pair and stores its logo", () => {
    const snap = snapshotFromPairs(MINT, [
      {
        baseToken: { address: MINT, symbol: "BONK", name: "Bonk" },
        quoteToken: { address: "SOL", symbol: "SOL", name: "Wrapped SOL" },
        priceUsd: "0.00002",
        liquidity: { usd: 10 },
        marketCap: 1000,
        info: { imageUrl: "https://cdn.example/small.png" },
      },
      {
        baseToken: { address: MINT, symbol: "BONK", name: "Bonk" },
        quoteToken: { address: "USDC", symbol: "USDC", name: "USDC" },
        priceUsd: "0.00003",
        liquidity: { usd: 5000 },
        marketCap: 2000,
        info: { imageUrl: "https://cdn.example/big.png" },
      },
    ]);
    expect(snap.symbol).toBe("BONK");
    expect(snap.name).toBe("Bonk");
    expect(snap.imageUrl).toBe("https://cdn.example/big.png");
    expect(snap.priceUsd).toBeCloseTo(0.00003);
    expect(snap.liqUsd).toBe(5000);
    expect(snap.mcapUsd).toBe(2000);
  });

  it("reads the base-token logo and ignores banners and quote-token art", () => {
    const snap = snapshotFromPairs(MINT, [
      {
        dexId: "raydium",
        baseToken: { address: "Other111111111111111111111111111111111111", name: "Other", symbol: "OTH" },
        quoteToken: { address: MINT, name: "Mine", symbol: "MINE" },
        liquidity: { usd: 9_000 },
        priceUsd: "2",
        info: { imageUrl: "https://cdn.example/other.png", header: "https://cdn.example/banner.png" },
      },
      {
        dexId: "orca",
        baseToken: { address: MINT, name: "  ", symbol: "" },
        quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "SOL" },
        liquidity: { usd: 100 },
        info: { imageUrl: "https://cdn.example/mine.png", header: "https://cdn.example/mine-banner.png" },
      },
      {
        dexId: "meteora",
        baseToken: { address: MINT, name: "Real Mine", symbol: "MINE" },
        quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USDC" },
        liquidity: { usd: 50 },
        info: { imageUrl: "http://cdn.example/insecure.png" },
      },
    ]);
    expect(snap.symbol).toBe("MINE");
    expect(snap.name).toBe("Mine");
    expect(snap.imageUrl).toBe("https://cdn.example/mine.png");
    expect(snap.priceUsd).toBeNull();
    expect(snap.pairCount).toBe(3);
    expect(snap.liqUsd).toBe(100);
  });

  it("keeps stored names and only fills blanks", () => {
    expect(fillMissingText("BONK", "OTHER")).toBeUndefined();
    expect(fillMissingText("  ", "Bonk")).toBe("Bonk");
    expect(fillMissingText(null, "  ")).toBeUndefined();
    expect(
      missingMetadata(
        { symbol: "BONK", name: null, imageUrl: null },
        { symbol: "NOPE", name: "Bonk", imageUrl: "javascript:alert(1)" },
      ),
    ).toEqual({ name: "Bonk" });
  });

  it("labels a token with real metadata or a shortened mint", () => {
    expect(tokenTitle("BONK", "Bonk", MINT)).toBe("BONK");
    expect(tokenSubtitle("BONK", "Bonk")).toBeNull();
    expect(tokenSubtitle("BONK", "Bonk Inu")).toBe("Bonk Inu");
    expect(tokenTitle(null, "Bonk Inu", MINT)).toBe("Bonk Inu");
    expect(tokenTitle(null, null, MINT)).toBe("Mint…1111");
    expect(tokenTitle("Unknown", null, MINT)).toBe("Unknown");
    expect(gmgnTokenUrl(MINT)).toBe(`https://gmgn.ai/sol/token/${MINT}`);
  });

  it("reads 6h and 24h volume and https socials from the same pairs", () => {
    const snap = snapshotFromPairs(MINT, [
      {
        baseToken: { address: MINT, symbol: "BONK", name: "Bonk" },
        liquidity: { usd: 10 },
        volume: { h1: 5, h6: 9, h24: 12 },
        info: {
          socials: [{ type: "twitter", url: "https://x.com/shallow" }],
        },
      },
      {
        baseToken: { address: MINT, symbol: "BONK", name: "Bonk" },
        liquidity: { usd: 5000 },
        volume: { m5: 1, h1: 80, h6: 200, h24: 900 },
        info: {
          websites: [{ url: "http://insecure.example" }, { url: "https://bonk.example" }],
          socials: [
            { type: "telegram", url: "https://t.me/bonk" },
            { type: "discord", url: "https://discord.gg/nope" },
          ],
        },
      },
    ]);
    expect(snap.volH1).toBe(80);
    expect(snap.volH6).toBe(200);
    expect(snap.volH24).toBe(900);
    expect(snap.socials).toEqual({
      twitter: "https://x.com/shallow",
      telegram: "https://t.me/bonk",
      website: "https://bonk.example/",
    });
  });
});
