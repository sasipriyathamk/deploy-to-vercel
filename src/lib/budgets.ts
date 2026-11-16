export type ProviderName =
  | "dexscreener"
  | "jupiter"
  | "rugcheck"
  | "geckoterminal"
  | "rpc"
  | "helius"
  | "pump"
  | "gmgn";

/** Helius RPC and the enhanced transactions API share one key, so they share one gate. */
export function providerGate(provider: ProviderName): string {
  if (provider === "helius") return "helius";
  if (provider === "rpc" && process.env.HELIUS_API_KEY?.trim()) return "helius";
  return provider;
}

export function budgetPerMinute(provider: ProviderName): number {
  switch (provider) {
    case "dexscreener":
      return 200;
    case "jupiter":
      return process.env.JUPITER_API_KEY ? 120 : 20;
    case "rugcheck":
      return 50;
    case "geckoterminal":
      return 5;
    case "pump":
      return 30;
    case "gmgn":
      return 20;
    case "helius":
    case "rpc":
      return process.env.HELIUS_API_KEY ? 120 : 20;
    default:
      return 10;
  }
}

export function minGapMs(provider: ProviderName): number {
  switch (provider) {
    case "rugcheck":
      return 1100;
    case "geckoterminal":
      return 12_000;
    case "jupiter":
      return process.env.JUPITER_API_KEY ? 250 : 2500;
    case "pump":
      return 250;
    case "gmgn":
      return 400;
    case "helius":
    case "rpc":
      return process.env.HELIUS_API_KEY ? 500 : 400;
    default:
      return 0;
  }
}

/** Numeric budget check. Counts often arrive as strings; `"3" >= "120"` is true, so both sides are coerced. */
export function exceedsProviderBudget(used: unknown, budget: unknown): boolean {
  const count = typeof used === "number" ? used : Number(used);
  const limit = typeof budget === "number" ? budget : Number(budget);
  if (!Number.isFinite(count) || !Number.isFinite(limit)) return false;
  return count >= limit;
}

/** Parsed transaction config. Versioned v0 swaps fail closed without the version field. */
export const PARSED_TX_CONFIG = {
  encoding: "jsonParsed",
  maxSupportedTransactionVersion: 0,
  commitment: "confirmed",
} as const;

export const PARSED_TX_METHOD_CONFIG = {
  maxSupportedTransactionVersion: 0,
  commitment: "confirmed",
} as const;

export function rpcUrl(): string {
  const configured = process.env.PUBLIC_RPC_URL?.trim();
  const publicRpc = "https://api.mainnet-beta.solana.com";
  if (configured && configured !== publicRpc) return configured;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return configured || publicRpc;
}
