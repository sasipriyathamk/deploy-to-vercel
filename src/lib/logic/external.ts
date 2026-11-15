import type { Side } from "@/lib/logic/parse";

export type ExternalTrade = {
  mint: string;
  side: Side;
  solDelta: number | null;
  tokenDelta: number | null;
  source: string;
};

export type PublicTokenMeta = {
  observedAt?: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function collectRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  for (const key of ["trades", "history", "list", "activities", "transactions"]) {
    if (Array.isArray(body[key])) return body[key].filter(isRecord);
  }
  if (Array.isArray(body.data)) return body.data.filter(isRecord);
  if (!isRecord(body.data)) return [];
  for (const key of ["trades", "history", "list", "activities", "token", "tokens"]) {
    if (Array.isArray(body.data[key])) return body.data[key].filter(isRecord);
  }
  return [];
}

function rowSignature(row: Record<string, unknown>): string | null {
  for (const key of ["signature", "tx", "tx_hash", "txHash", "transactionHash", "hash"]) {
    const value = text(row[key]);
    if (value) return value;
  }
  return null;
}

function rowWallet(row: Record<string, unknown>): string | null {
  for (const key of ["user", "userAddress", "maker", "owner", "trader", "wallet", "address"]) {
    const value = text(row[key]);
    if (value) return value;
  }
  return null;
}

function rowSide(row: Record<string, unknown>): Side | null {
  if (typeof row.is_buy === "boolean") return row.is_buy ? "buy" : "sell";
  if (typeof row.isBuy === "boolean") return row.isBuy ? "buy" : "sell";
  const label = String(row.side ?? row.type ?? row.event ?? row.event_type ?? row.trade_type ?? row.swapType ?? "").toLowerCase();
  if (label.includes("buy")) return "buy";
  if (label.includes("sell")) return "sell";
  return null;
}

/** Pump `sol_amount` is lamports. GMGN quote amounts are sometimes already SOL. */
export function solFromRaw(value: number | null, side: Side): number | null {
  if (value == null || !Number.isFinite(value) || value === 0) return null;
  const sol = Math.abs(value) >= 1_000 ? Math.abs(value) / 1_000_000_000 : Math.abs(value);
  if (!Number.isFinite(sol) || sol === 0) return null;
  return side === "buy" ? -sol : sol;
}

function tokenFromRaw(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value === 0) return null;
  return value;
}

export function tradeFromRows(body: unknown, signature: string, wallet: string, mint: string, source: string): ExternalTrade | null {
  for (const row of collectRows(body)) {
    const rowSig = rowSignature(row);
    if (!rowSig || rowSig !== signature) continue;
    const actor = rowWallet(row);
    if (actor && actor !== wallet) continue;
    const side = rowSide(row);
    if (!side) continue;
    const sol = solFromRaw(
      num(row.sol_amount ?? row.solAmount ?? row.quote_amount ?? row.quoteAmount ?? row.native_sol ?? row.sol),
      side,
    );
    const token = tokenFromRaw(num(row.token_amount ?? row.tokenAmount ?? row.amount ?? row.base_amount ?? row.token));
    const rowMint = text(row.mint ?? row.token_address ?? row.tokenAddress) ?? mint;
    return {
      mint: rowMint,
      side,
      solDelta: sol,
      tokenDelta: token == null ? null : side === "buy" ? Math.abs(token) : -Math.abs(token),
      source,
    };
  }
  return null;
}

function metaFromRecord(row: Record<string, unknown>, source: string): PublicTokenMeta | null {
  const symbol = text(row.symbol ?? row.token_symbol);
  const name = text(row.name ?? row.token_name);
  const imageUrl = text(row.image_uri ?? row.imageUri ?? row.image_url ?? row.imageUrl ?? row.logo ?? row.icon);
  const priceUsd = num(row.price_usd ?? row.priceUsd ?? row.usdPrice ?? row.price);
  const mcapUsd = num(row.usd_market_cap ?? row.market_cap ?? row.marketCap ?? row.fdv ?? row.usd_marketcap);
  if (!symbol && !name && !imageUrl && priceUsd == null && mcapUsd == null) return null;
  return { symbol, name, imageUrl, priceUsd, mcapUsd, source };
}

export function parsePumpCoin(body: unknown): PublicTokenMeta | null {
  if (!isRecord(body)) return null;
  const row = isRecord(body.coin) ? body.coin : isRecord(body.data) ? body.data : body;
  return metaFromRecord(row, "pump.fun");
}

export function parseGmgnToken(body: unknown): PublicTokenMeta | null {
  if (!isRecord(body)) return null;
  const data = isRecord(body.data) ? body.data : body;
  const token = isRecord(data.token) ? data.token : isRecord(data.info) ? data.info : data;
  return metaFromRecord(token, "gmgn");
}

export function mergeMeta(current: PublicTokenMeta | null, incoming: PublicTokenMeta | null): PublicTokenMeta | null {
  if (!incoming) return current;
  if (!current) return incoming;
  const quote = current.priceUsd != null || current.mcapUsd != null ? current : incoming;
  return {
    symbol: current.symbol ?? incoming.symbol,
    name: current.name ?? incoming.name,
    imageUrl: current.imageUrl ?? incoming.imageUrl,
    priceUsd: quote.priceUsd,
    mcapUsd: quote.mcapUsd,
    source: quote.source,
    observedAt: quote.observedAt,
  };
}

/** Try each source. A throw or empty result never blocks the next one. */
export async function firstUsable<T>(sources: Array<() => Promise<T | null | undefined>>): Promise<T | null> {
  for (const source of sources) {
    try {
      const value = await source();
      if (value != null) return value;
    } catch {
      // One dead upstream must not stop the fallback chain.
    }
  }
  return null;
}
