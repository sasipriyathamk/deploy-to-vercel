import { shortAddress } from "@/lib/format";

export function blankToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Absolute https URLs only. Token CDNs are https; anything else is not a logo. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Keep a stored value. Return a replacement only when the stored value is blank. */
export function fillMissingText(current: string | null | undefined, incoming: string | null | undefined): string | undefined {
  if (blankToNull(current)) return undefined;
  return blankToNull(incoming) ?? undefined;
}

export type TokenIdentity = {
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
};

export function missingMetadata(current: TokenIdentity, incoming: TokenIdentity): Partial<TokenIdentity> {
  const patch: Partial<TokenIdentity> = {};
  const symbol = fillMissingText(current.symbol, incoming.symbol);
  const name = fillMissingText(current.name, incoming.name);
  const imageUrl = fillMissingText(current.imageUrl, httpsUrl(incoming.imageUrl));
  if (symbol) patch.symbol = symbol;
  if (name) patch.name = name;
  if (imageUrl) patch.imageUrl = imageUrl;
  return patch;
}

export function tokenTitle(
  symbol: string | null | undefined,
  name: string | null | undefined,
  mint: string | null | undefined,
): string {
  const sym = blankToNull(symbol);
  if (sym) return sym;
  const named = blankToNull(name);
  if (named) return named;
  if (blankToNull(mint)) return shortAddress(mint);
  return "—";
}

export function tokenSubtitle(symbol: string | null | undefined, name: string | null | undefined): string | null {
  const named = blankToNull(name);
  const sym = blankToNull(symbol);
  if (!named || !sym) return null;
  if (named.toLowerCase() === sym.toLowerCase()) return null;
  return named;
}

export function gmgnTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint)}`;
}
