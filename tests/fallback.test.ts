import { describe, expect, it } from "vitest";
import { firstUsable, tradeFromRows } from "@/lib/logic/external";

const wallet = "STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk";
const mint = "Mint111111111111111111111111111111111111111";

describe("external fallbacks", () => {
  it("keeps going when one source throws", async () => {
    const trade = await firstUsable([
      async () => {
        throw new Error("pump down");
      },
      async () => null,
      async () => ({ mint, side: "sell" as const, solDelta: 0.2, tokenDelta: -4, source: "gmgn" }),
    ]);
    expect(trade?.side).toBe("sell");
    expect(trade?.source).toBe("gmgn");
  });

  it("returns null when every source fails", async () => {
    await expect(
      firstUsable([
        async () => {
          throw new Error("helius down");
        },
        async () => {
          throw new Error("gmgn down");
        },
      ]),
    ).resolves.toBeNull();
  });

  it("matches a pump trade and a gmgn trade for the watched wallet", () => {
    const pump = tradeFromRows(
      [{ signature: "sig-1", user: wallet, is_buy: false, sol_amount: 400_000_000, token_amount: 9, mint }],
      "sig-1",
      wallet,
      mint,
      "pump.fun",
    );
    expect(pump).toMatchObject({ side: "sell", solDelta: 0.4, source: "pump.fun" });
    const gmgn = tradeFromRows(
      { data: { history: [{ tx_hash: "sig-2", maker: wallet, event: "buy", quote_amount: 0.25, token_amount: 3 }] } },
      "sig-2",
      wallet,
      mint,
      "gmgn",
    );
    expect(gmgn).toMatchObject({ side: "buy", solDelta: -0.25, tokenDelta: 3, source: "gmgn" });
  });
});
it("keeps fallback price and market cap from the same source", async () => {
  const {mergeMeta}=await import('@/lib/logic/external');
  const base={symbol:'TOKEN',name:null,imageUrl:null,priceUsd:1,mcapUsd:null,source:'pump.fun'};
  const merged=mergeMeta(base,{...base,priceUsd:2,mcapUsd:200,source:'gmgn'});
  expect(merged).toMatchObject({priceUsd:1,mcapUsd:null,source:'pump.fun'});
});
