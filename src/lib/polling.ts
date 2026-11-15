/** Shared request cache prevents duplicate polls when views consume the same URL. */
const cache = new Map<string, { data: unknown; at: number }>();
const pending = new Map<string, Promise<unknown>>();
export function cachedPoll<T>(url: string): T | null {
  return (cache.get(url)?.data as T) ?? null;
}
export function pollJson<T>(url: string): Promise<T> {
  const active = pending.get(url);
  if (active) return active as Promise<T>;
  const request = (async () => {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error || "Request failed");
    cache.delete(url);
    cache.set(url, { data: body, at: Date.now() });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return body as T;
  })().finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}
