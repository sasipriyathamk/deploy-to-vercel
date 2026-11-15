/** Editable hard-drop list. Add mint addresses that should never enter the funnel. */
export const DENYLIST: readonly string[] = [
  "JunkMintDenylist11111111111111111111111111",
];

/** SOL, wrapped SOL, and stables are quote assets, not sniper memecoins. */
export const QUOTE_MINTS: readonly string[] = [
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
];

const deny = new Set(DENYLIST);
const quotes = new Set(QUOTE_MINTS);

export type JunkReason = "denylist" | "quote_asset";

export function junkReason(mint: string): JunkReason | null {
  if (quotes.has(mint)) return "quote_asset";
  if (deny.has(mint)) return "denylist";
  return null;
}

export function isQuoteMint(mint: string): boolean {
  return quotes.has(mint);
}

export type DiscoveryPlan =
  | { action: "ignore"; reason: "quote_asset" }
  | { action: "reject"; reason: "denylist" }
  | { action: "track" };

/** Quote mints are not tokens. Denylist mints are stored as rejected_junk. */
export function planDiscovery(mint: string): DiscoveryPlan {
  const reason = junkReason(mint);
  if (reason === "quote_asset") return { action: "ignore", reason };
  if (reason === "denylist") return { action: "reject", reason };
  return { action: "track" };
}
