import { describe, expect, it } from "vitest";
import { PROGRAMS } from "@/lib/logic/venue";
import {
  WSOL_MINT,
  classifyTrade,
  normalizeHelius,
  normalizeRpc,
  shouldDiscoverToken,
  type RpcTransaction,
} from "@/lib/logic/parse";

const wallet = "STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk";
const meme = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("helius buy parse", () => {
  it("records a pump.fun buy and ignores the wrapped SOL leg", () => {
    const event = normalizeHelius(
      {
        signature: "sig-buy",
        slot: 10,
        timestamp: 1_700_000_000,
        source: "PUMP_FUN",
        feePayer: wallet,
        transactionError: null,
        instructions: [{ programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" }],
        accountData: [
          {
            account: wallet,
            nativeBalanceChange: -500_000_000,
            tokenBalanceChanges: [],
          },
          {
            account: "token-account",
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                mint: meme,
                userAccount: wallet,
                rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
              },
              {
                mint: "So11111111111111111111111111111111111111112",
                userAccount: wallet,
                rawTokenAmount: { tokenAmount: "-200000000", decimals: 9 },
              },
            ],
          },
        ],
      },
      new Set([wallet]),
    );
    expect(event?.mint).toBe(meme);
    expect(event?.side).toBe("buy");
    expect(event?.solDelta).toBeCloseTo(-0.5);
    expect(event?.venue.venue).toBe("pump.fun");
    expect(event && shouldDiscoverToken(event, new Set([wallet]))).toBe(true);
  });

  it("stores failed transactions without discovering a token", () => {
    const event = normalizeHelius(
      {
        signature: "sig-fail",
        feePayer: wallet,
        transactionError: { InstructionError: [0, "Custom"] },
        accountData: [
          {
            account: wallet,
            nativeBalanceChange: -5000,
            tokenBalanceChanges: [
              {
                mint: meme,
                userAccount: wallet,
                rawTokenAmount: { tokenAmount: "10", decimals: 6 },
              },
            ],
          },
        ],
      },
      new Set([wallet]),
    );
    expect(event?.err).toBe(true);
    expect(event && shouldDiscoverToken(event, new Set([wallet]))).toBe(false);
  });
});

function versionedSwap(input: {
  side: "buy" | "sell";
  programId: string;
  programIndex?: boolean;
  feeOnlySol?: boolean;
  wsolOut?: boolean;
}): RpcTransaction {
  const tokenIn = input.side === "buy";
  const preToken = tokenIn ? "0" : "5000000";
  const postToken = tokenIn ? "2500000" : "1000000";
  const preSol = input.feeOnlySol ? 1_000_000_000 : tokenIn ? 2_000_000_000 : 1_000_000_000;
  const postSol = input.feeOnlySol ? 999_995_000 : tokenIn ? 1_500_000_000 : 1_400_000_000;
  const keys = input.programIndex
    ? [{ pubkey: input.programId }, { pubkey: wallet }]
    : [{ pubkey: wallet }, { pubkey: input.programId }];
  const walletIndex = input.programIndex ? 1 : 0;
  return {
    slot: 20,
    blockTime: 1_700_000_100,
    version: 0,
    meta: {
      err: null,
      preBalances: input.programIndex ? [0, preSol] : [preSol, 0],
      postBalances: input.programIndex ? [0, postSol] : [postSol, 0],
      loadedAddresses: input.programIndex ? { writable: [wallet], readonly: [] } : { writable: [], readonly: [] },
      preTokenBalances: [
        {
          owner: wallet,
          mint: meme,
          accountIndex: walletIndex,
          uiTokenAmount: { uiAmount: null, amount: preToken, decimals: 6 },
        },
        ...(input.wsolOut
          ? [{ owner: wallet, mint: WSOL_MINT, uiTokenAmount: { uiAmount: 1, decimals: 9, amount: "1000000000" } }]
          : []),
      ],
      postTokenBalances: [
        {
          owner: wallet,
          mint: meme,
          accountIndex: walletIndex,
          uiTokenAmount: { uiAmount: null, uiAmountString: tokenIn ? "2.5" : "1", amount: postToken, decimals: 6 },
        },
        ...(input.wsolOut
          ? [{ owner: wallet, mint: WSOL_MINT, uiTokenAmount: { uiAmount: 0.2, decimals: 9, amount: "200000000" } }]
          : []),
      ],
      innerInstructions: [],
    },
    transaction: {
      signatures: ["sig-v0"],
      message: {
        accountKeys: input.programIndex ? [{ pubkey: input.programId }] : keys,
        instructions: input.programIndex ? [{ programIdIndex: 0 }] : [{ programId: input.programId }],
      },
    },
  };
}

describe("versioned balance deltas", () => {
  it("reads a v0 pump.fun buy from raw amounts when uiAmount is null", () => {
    const event = normalizeRpc(versionedSwap({ side: "buy", programId: PROGRAMS.pumpFun, programIndex: true }), wallet, "sig-v0");
    expect(event?.side).toBe("buy");
    expect(event?.mint).toBe(meme);
    expect(event?.tokenDelta).toBeCloseTo(2.5);
    expect(event?.solDelta).toBeCloseTo(-0.5);
    expect(event?.venue.venue).toBe("pump.fun");
    expect(event?.tokenAfter).toBeCloseTo(2.5);
    expect(event && shouldDiscoverToken(event, new Set([wallet]))).toBe(true);
  });

  it("reads quick sells on PumpSwap, Raydium, and Meteora", () => {
    for (const [programId, venue] of [
      [PROGRAMS.pumpAmm, "pump.amm"],
      [PROGRAMS.raydiumV4, "raydium"],
      [PROGRAMS.meteoraDlmm, "meteora"],
    ] as const) {
      const event = normalizeRpc(versionedSwap({ side: "sell", programId }), wallet, "sig-sell");
      expect(event?.side).toBe("sell");
      expect(event?.mint).toBe(meme);
      expect(event?.solDelta).toBeCloseTo(0.4);
      expect(event?.venue.venue).toBe(venue);
      expect(event && shouldDiscoverToken(event, new Set([wallet]))).toBe(false);
    }
  });

  it("treats Jupiter WSOL out plus a token in as a buy even when native SOL is only the fee", () => {
    const event = normalizeRpc(
      versionedSwap({ side: "buy", programId: PROGRAMS.jupiterV6, feeOnlySol: true, wsolOut: true }),
      wallet,
      "sig-jup",
    );
    expect(event?.side).toBe("buy");
    expect(event?.mint).toBe(meme);
    expect(event?.venue.venue).toBe("jupiter");
  });

  it("classifies quote flow without caring which venue moved the tokens", () => {
    expect(classifyTrade([{ mint: meme, delta: 10, decimals: 6 }], -0.4).side).toBe("buy");
    expect(classifyTrade([{ mint: meme, delta: -10, decimals: 6 }], 0.4).side).toBe("sell");
  });
});
