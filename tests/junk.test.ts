import { describe, expect, it } from "vitest";
import { DENYLIST, junkReason, planDiscovery } from "@/lib/logic/junk";
import { classifyTrade } from "@/lib/logic/parse";

describe("junk mint reject", () => {
  it("hard-drops wrapped SOL and stables", () => {
    expect(junkReason("So11111111111111111111111111111111111111112")).toBe("quote_asset");
    expect(junkReason("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("quote_asset");
    expect(planDiscovery("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")).toEqual({
      action: "ignore",
      reason: "quote_asset",
    });
  });

  it("rejects the editable denylist", () => {
    expect(planDiscovery(DENYLIST[0]!)).toEqual({ action: "reject", reason: "denylist" });
  });

  it("tracks an ordinary mint", () => {
    expect(planDiscovery("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263").action).toBe("track");
  });

  it("does not treat a USDC balance increase as a token buy", () => {
    const trade = classifyTrade(
      [
        { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", delta: 25, decimals: 6 },
        { mint: "So11111111111111111111111111111111111111112", delta: -0.2, decimals: 9 },
      ],
      -0.2,
    );
    expect(trade.side).toBe("unknown");
    expect(trade.mint).toBeNull();
  });
});
