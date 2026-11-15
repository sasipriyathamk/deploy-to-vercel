import { isQuoteMint } from "@/lib/logic/junk";
import { venueFromPrograms, type VenueGuess } from "@/lib/logic/venue";

export type Side = "buy" | "sell" | "unknown";

export type NormalizedEvent = {
  signature: string;
  slot: number | null;
  blockTime: Date | null;
  err: boolean;
  programs: string[];
  source: string | null;
  wallet: string;
  mint: string | null;
  side: Side;
  solDelta: number | null;
  tokenDelta: number | null;
  decimals: number | null;
  /** Post-trade balance of `mint` for the wallet, when the RPC meta includes it. */
  tokenAfter?: number | null;
  venue: VenueGuess;
  raw: unknown;
};

type TokenChange = { mint: string; delta: number; decimals: number | null };

export type HeliusLike = {
  signature?: string;
  slot?: number;
  timestamp?: number;
  type?: string;
  source?: string;
  feePayer?: string;
  description?: string;
  transactionError?: unknown;
  instructions?: { programId?: string; innerInstructions?: { programId?: string }[] }[];
  tokenTransfers?: {
    fromUserAccount?: string;
    toUserAccount?: string;
    mint?: string;
    tokenAmount?: number;
  }[];
  accountData?: {
    account?: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: {
      mint?: string;
      userAccount?: string;
      rawTokenAmount?: { tokenAmount?: string; decimals?: number };
    }[];
  }[];
};

export function extractPrograms(tx: HeliusLike): string[] {
  const ids = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    if (ix.programId) ids.add(ix.programId);
    for (const inner of ix.innerInstructions ?? []) {
      if (inner.programId) ids.add(inner.programId);
    }
  }
  return [...ids];
}

export function resolveWatchedWallet(tx: HeliusLike, watched: ReadonlySet<string>): string | null {
  if (tx.feePayer && watched.has(tx.feePayer)) return tx.feePayer;
  for (const account of tx.accountData ?? []) {
    if (account.account && watched.has(account.account)) return account.account;
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount && watched.has(change.userAccount)) return change.userAccount;
    }
  }
  for (const transfer of tx.tokenTransfers ?? []) {
    if (transfer.toUserAccount && watched.has(transfer.toUserAccount)) return transfer.toUserAccount;
    if (transfer.fromUserAccount && watched.has(transfer.fromUserAccount)) return transfer.fromUserAccount;
  }
  return null;
}

function addChange(map: Map<string, TokenChange>, mint: string | undefined, delta: number, decimals: number | null) {
  if (!mint || !Number.isFinite(delta) || delta === 0) return;
  const prev = map.get(mint);
  if (prev) {
    prev.delta += delta;
    if (prev.decimals == null) prev.decimals = decimals;
    return;
  }
  map.set(mint, { mint, delta, decimals });
}

export function tokenChangesForWallet(tx: HeliusLike, wallet: string): TokenChange[] {
  const map = new Map<string, TokenChange>();
  for (const account of tx.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount !== wallet || !change.mint) continue;
      const decimals = change.rawTokenAmount?.decimals ?? 0;
      const raw = Number(change.rawTokenAmount?.tokenAmount ?? 0);
      const ui = Number.isFinite(raw) ? raw / 10 ** decimals : 0;
      addChange(map, change.mint, ui, decimals);
    }
  }
  if (map.size === 0) {
    for (const transfer of tx.tokenTransfers ?? []) {
      if (!transfer.mint || transfer.tokenAmount == null) continue;
      if (transfer.toUserAccount === wallet) addChange(map, transfer.mint, transfer.tokenAmount, null);
      if (transfer.fromUserAccount === wallet) addChange(map, transfer.mint, -transfer.tokenAmount, null);
    }
  }
  return [...map.values()];
}

export function solDeltaForWallet(tx: HeliusLike, wallet: string): number | null {
  let lamports = 0;
  let found = false;
  for (const account of tx.accountData ?? []) {
    if (account.account === wallet && typeof account.nativeBalanceChange === "number") {
      lamports += account.nativeBalanceChange;
      found = true;
    }
  }
  if (!found) return null;
  return lamports / 1_000_000_000;
}

/** Wrapped SOL. Native SOL is not a mint; this is the quote leg on AMM and Jupiter swaps. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Ignore fee-sized native SOL movement so a priority fee is not treated as the swap quote.
 * Real sniper buys and quick sells move more SOL than this.
 */
export const SOL_FEE_NOISE = 0.00002;

export type TradeClassification = {
  side: Side;
  mint: string | null;
  tokenDelta: number | null;
  decimals: number | null;
  solDelta: number | null;
};

function quoteDirection(changes: TokenChange[], solDelta: number | null): { out: boolean; inn: boolean } {
  const wrapped = changes.filter((change) => change.mint === WSOL_MINT).reduce((sum, change) => sum + change.delta, 0);
  const sol = (solDelta ?? 0) + wrapped;
  const stable = changes
    .filter((change) => isQuoteMint(change.mint) && change.mint !== WSOL_MINT)
    .reduce((sum, change) => sum + change.delta, 0);
  const out = sol < -SOL_FEE_NOISE || stable < 0;
  const inn = sol > SOL_FEE_NOISE || stable > 0;
  return { out, inn };
}

/**
 * Generic swap read: SOL or WSOL out plus a token in is a buy, and the reverse is a sell.
 * A single non-quote delta still counts when the quote leg is only a fee or is missing.
 */
export function classifyTrade(changes: TokenChange[], solDelta: number | null): TradeClassification {
  const meaningful = changes.filter((change) => !isQuoteMint(change.mint) && change.delta !== 0);
  const incoming = meaningful.filter((change) => change.delta > 0).sort((a, b) => b.delta - a.delta);
  const outgoing = meaningful.filter((change) => change.delta < 0).sort((a, b) => a.delta - b.delta);
  const quote = quoteDirection(changes, solDelta);
  const buyOf = (change: TokenChange): TradeClassification => ({
    side: "buy",
    mint: change.mint,
    tokenDelta: change.delta,
    decimals: change.decimals,
    solDelta,
  });
  const sellOf = (change: TokenChange): TradeClassification => ({
    side: "sell",
    mint: change.mint,
    tokenDelta: change.delta,
    decimals: change.decimals,
    solDelta,
  });
  if (incoming[0] && quote.out && !quote.inn) return buyOf(incoming[0]);
  if (outgoing[0] && quote.inn && !quote.out) return sellOf(outgoing[0]);
  if (incoming[0] && !outgoing[0]) return buyOf(incoming[0]);
  if (outgoing[0] && !incoming[0]) return sellOf(outgoing[0]);
  if (incoming[0] && outgoing[0]) {
    if (quote.out && !quote.inn) return buyOf(incoming[0]);
    if (quote.inn && !quote.out) return sellOf(outgoing[0]);
    if (incoming[0].delta >= Math.abs(outgoing[0].delta)) return buyOf(incoming[0]);
    return sellOf(outgoing[0]);
  }
  return { side: "unknown", mint: null, tokenDelta: null, decimals: null, solDelta };
}

export function trimRaw(tx: HeliusLike): unknown {
  return {
    type: tx.type ?? null,
    source: tx.source ?? null,
    description: typeof tx.description === "string" ? tx.description.slice(0, 280) : null,
    feePayer: tx.feePayer ?? null,
    transactionError: tx.transactionError ?? null,
    programs: extractPrograms(tx).slice(0, 24),
    tokenTransfers: (tx.tokenTransfers ?? []).slice(0, 16),
  };
}

export function normalizeHelius(tx: HeliusLike, watched: ReadonlySet<string>): NormalizedEvent | null {
  if (!tx.signature) return null;
  const wallet = resolveWatchedWallet(tx, watched) ?? tx.feePayer ?? "unknown";
  const programs = extractPrograms(tx);
  const trade = classifyTrade(tokenChangesForWallet(tx, wallet), solDeltaForWallet(tx, wallet));
  const err = Boolean(tx.transactionError);
  return {
    signature: tx.signature,
    slot: tx.slot ?? null,
    blockTime: tx.timestamp ? new Date(tx.timestamp * 1000) : null,
    err,
    programs,
    source: tx.source ?? null,
    wallet,
    mint: err ? trade.mint : trade.mint,
    side: err ? trade.side : trade.side,
    solDelta: trade.solDelta,
    tokenDelta: trade.tokenDelta,
    decimals: trade.decimals,
    venue: venueFromPrograms(programs, tx.source),
    raw: trimRaw(tx),
  };
}

export function shouldDiscoverToken(event: Pick<NormalizedEvent, "err" | "side" | "mint" | "wallet">, watched: ReadonlySet<string>): boolean {
  return !event.err && event.side === "buy" && Boolean(event.mint) && watched.has(event.wallet);
}

export function coerceWebhookBody(body: unknown): HeliusLike[] {
  if (Array.isArray(body)) return body.filter((item) => item && typeof item === "object") as HeliusLike[];
  if (!body || typeof body !== "object") return [];
  const record = body as { transactions?: unknown; signature?: string };
  if (Array.isArray(record.transactions)) {
    return record.transactions.filter((item) => item && typeof item === "object") as HeliusLike[];
  }
  if (typeof record.signature === "string") return [record as HeliusLike];
  return [];
}

type RpcTokenAmount = {
  uiAmount?: number | null;
  uiAmountString?: string | null;
  amount?: string | null;
  decimals?: number | null;
};

type RpcTokenBal = {
  owner?: string;
  mint?: string;
  accountIndex?: number;
  uiTokenAmount?: RpcTokenAmount;
};

type RpcIx = { programId?: string; programIdIndex?: number };

export type RpcTransaction = {
  slot?: number;
  blockTime?: number | null;
  version?: number | "legacy";
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: RpcTokenBal[];
    postTokenBalances?: RpcTokenBal[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
    innerInstructions?: { instructions?: RpcIx[] }[];
  } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: ({ pubkey?: string } | string)[];
      instructions?: RpcIx[];
    };
  };
};

/** Solana returns this when a v0 transaction is fetched without maxSupportedTransactionVersion. */
export function isVersionedTxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /maxSupportedTransactionVersion/i.test(message) || /transaction version/i.test(message);
}

/** uiAmount is often null on versioned jsonParsed responses. Fall back to the raw amount. */
export function uiTokenAmount(amount: RpcTokenAmount | null | undefined): number {
  if (!amount) return 0;
  if (typeof amount.uiAmount === "number" && Number.isFinite(amount.uiAmount)) return amount.uiAmount;
  if (typeof amount.uiAmountString === "string" && amount.uiAmountString.trim()) {
    const parsed = Number(amount.uiAmountString);
    if (Number.isFinite(parsed)) return parsed;
  }
  const raw = amount.amount == null ? Number.NaN : Number(amount.amount);
  const decimals = amount.decimals ?? 0;
  if (Number.isFinite(raw)) return raw / 10 ** decimals;
  return 0;
}

function pubkeyOf(key: { pubkey?: string } | string | undefined): string | null {
  if (!key) return null;
  return typeof key === "string" ? key : key.pubkey ?? null;
}

/**
 * Balance indexes follow static keys, then loaded writable, then loaded readonly.
 * jsonParsed sometimes already merges lookup-table keys into accountKeys.
 */
export function orderedAccountKeys(tx: RpcTransaction): string[] {
  const listed = (tx.transaction?.message?.accountKeys ?? [])
    .map((key) => pubkeyOf(key))
    .filter((key): key is string => Boolean(key));
  const loaded = [...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const have = new Set(listed);
  return [...listed, ...loaded.filter((key) => key && !have.has(key))];
}

function programIdsFromRpc(tx: RpcTransaction, keys: string[]): string[] {
  const ids: string[] = [];
  const push = (ix?: RpcIx) => {
    if (!ix) return;
    if (ix.programId) ids.push(ix.programId);
    else if (typeof ix.programIdIndex === "number" && keys[ix.programIdIndex]) ids.push(keys[ix.programIdIndex]!);
  };
  for (const ix of tx.transaction?.message?.instructions ?? []) push(ix);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) push(ix);
  }
  return [...new Set(ids)];
}

function balancesByMint(
  rows: RpcTokenBal[] | undefined,
  wallet: string,
  keys: string[],
): Map<string, { amount: number; decimals: number | null }> {
  const map = new Map<string, { amount: number; decimals: number | null }>();
  for (const row of rows ?? []) {
    const owner = row.owner ?? (typeof row.accountIndex === "number" ? keys[row.accountIndex] ?? null : null);
    if (owner !== wallet || !row.mint) continue;
    const decimals = row.uiTokenAmount?.decimals ?? null;
    const prev = map.get(row.mint);
    const amount = uiTokenAmount(row.uiTokenAmount);
    if (prev) {
      prev.amount += amount;
      if (prev.decimals == null) prev.decimals = decimals;
    } else {
      map.set(row.mint, { amount, decimals });
    }
  }
  return map;
}

export function normalizeRpc(tx: RpcTransaction, wallet: string, signature: string): NormalizedEvent | null {
  if (!tx || (!tx.meta && !tx.transaction)) return null;
  const keys = orderedAccountKeys(tx);
  const index = keys.indexOf(wallet);
  let solDelta: number | null = null;
  if (index >= 0 && tx.meta?.preBalances && tx.meta.postBalances) {
    const pre = tx.meta.preBalances[index] ?? 0;
    const post = tx.meta.postBalances[index] ?? 0;
    solDelta = (post - pre) / 1_000_000_000;
  }
  const pre = balancesByMint(tx.meta?.preTokenBalances, wallet, keys);
  const post = balancesByMint(tx.meta?.postTokenBalances, wallet, keys);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  const changes: TokenChange[] = [];
  for (const mint of mints) {
    const before = pre.get(mint)?.amount ?? 0;
    const after = post.get(mint)?.amount ?? 0;
    changes.push({
      mint,
      delta: after - before,
      decimals: post.get(mint)?.decimals ?? pre.get(mint)?.decimals ?? null,
    });
  }
  const programs = programIdsFromRpc(tx, keys);
  const trade = classifyTrade(changes, solDelta);
  const tokenAfter =
    trade.mint == null ? null : post.has(trade.mint) ? post.get(trade.mint)!.amount : pre.has(trade.mint) ? 0 : null;
  return {
    signature,
    slot: tx.slot ?? null,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    err: Boolean(tx.meta?.err),
    programs,
    source: null,
    wallet,
    mint: trade.mint,
    side: trade.side,
    solDelta: trade.solDelta,
    tokenDelta: trade.tokenDelta,
    decimals: trade.decimals,
    tokenAfter,
    venue: venueFromPrograms(programs),
    raw: { rpc: true, version: tx.version ?? null, account: keys[index] ?? null },
  };
}

export function applyExternalTrade(
  base: NormalizedEvent | null,
  trade: { mint: string; side: Side; solDelta: number | null; tokenDelta: number | null; source: string },
  wallet: string,
  signature: string,
): NormalizedEvent {
  const programs = base?.programs ?? [];
  return {
    signature,
    slot: base?.slot ?? null,
    blockTime: base?.blockTime ?? null,
    err: false,
    programs,
    source: trade.source,
    wallet,
    mint: trade.mint,
    side: trade.side,
    solDelta: trade.solDelta ?? base?.solDelta ?? null,
    tokenDelta: trade.tokenDelta ?? base?.tokenDelta ?? null,
    decimals: base?.decimals ?? null,
    tokenAfter: base?.tokenAfter,
    venue: venueFromPrograms(programs, trade.source),
    raw: base?.raw ?? { fallback: trade.source },
  };
}
