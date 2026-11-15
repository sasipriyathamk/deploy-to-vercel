const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isSolanaAddress(value: string): boolean {
  return BASE58.test(value.trim());
}

export function likeContains(query: string): string {
  const escaped = query.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}
