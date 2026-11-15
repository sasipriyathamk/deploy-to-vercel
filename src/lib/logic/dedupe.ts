/** Returns signatures that are not already known, preserving order and dropping duplicates in the batch. */
export function newSignatures(known: Iterable<string>, incoming: readonly string[]): string[] {
  const seen = new Set(known);
  const fresh: string[] = [];
  for (const signature of incoming) {
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    fresh.push(signature);
  }
  return fresh;
}
