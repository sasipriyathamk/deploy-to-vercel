"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { GmgnLink, TokenLogo } from "@/components/token-meta";
import { EntryFacts } from "@/components/entry-facts";
import { Badge } from "@/components/ui/badge";
import { createSearchScheduler, SEARCH_DEBOUNCE_MS } from "@/lib/logic/debounce";
import { compactUsd, shortAddress } from "@/lib/format";
import { tokenSubtitle, tokenTitle } from "@/lib/logic/metadata";
import type { TokenDto } from "@/lib/present";

type SearchResponse = {
  tokens: TokenDto[];
  wallets: { address: string; label: string; enabled: boolean }[];
};

export function SearchBox() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [scheduler] = useState(() => createSearchScheduler(SEARCH_DEBOUNCE_MS));

  useEffect(() => () => scheduler.cancel(), [scheduler]);

  // Click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function onQuery(value: string) {
    setQuery(value);
    setOpen(true);
    const trimmed = value.trim();
    if (!trimmed) {
      scheduler.cancel();
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    scheduler.schedule(async (signal) => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal, cache: "no-store" });
        if (!response.ok) throw new Error("Search failed");
        const body = (await response.json()) as SearchResponse;
        if (signal.aborted) return;
        setResult(body);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (!signal.aborted) setError("Search failed. Try again.");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
  }

  function handleClear() {
    scheduler.cancel();
    setQuery("");
    setResult(null);
    setError(null);
    setLoading(false);
    setOpen(false);
    inputRef.current?.focus();
  }

  const tokens = result?.tokens ?? [];
  const wallets = result?.wallets ?? [];
  const show = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className="relative w-full">
      <label className="sr-only" htmlFor="keel-search">
        Search mints, symbols, names, and wallets
      </label>
      <Search className="pointer-events-none absolute top-2.5 md:top-3 left-3 size-4 text-muted/70" aria-hidden />
      <input
        ref={inputRef}
        id="keel-search"
        value={query}
        placeholder="Search token, symbol or address..."
        className="h-9 md:h-10 w-full rounded-xl border border-white/[0.08] bg-surface/80 pl-9 pr-9 text-xs sm:text-sm text-ink outline-none placeholder:text-muted/60 transition-all focus:border-emerald-500/50 focus:bg-surface focus:ring-2 focus:ring-emerald-500/20"
        onFocus={() => setOpen(true)}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "Enter" && tokens[0]) {
            setOpen(false);
            router.push(`/tokens/${tokens[0].mint}`);
          }
        }}
      />
      {query.length > 0 ? (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear search"
          className="absolute right-2.5 top-1.5 md:top-2 inline-flex size-6 items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-surface-hover"
        >
          <X className="size-3.5" />
        </button>
      ) : null}

      {show ? (
        <div className="absolute left-0 right-0 z-50 mt-1.5 max-h-[70vh] sm:max-h-80 w-full overflow-y-auto rounded-xl border border-white/[0.1] bg-paper-2/95 shadow-2xl backdrop-blur-2xl">
          {loading ? <p className="px-4 py-3 text-xs text-muted">Searching tokens & wallets…</p> : null}
          {error ? <p className="px-4 py-3 text-xs text-loss">{error}</p> : null}
          {!loading && !error && tokens.length === 0 && wallets.length === 0 ? (
            <p className="px-4 py-5 text-center text-xs text-muted">No mints, names, or wallets match.</p>
          ) : null}

          {wallets.length > 0 ? (
            <div className="border-b border-white/[0.06] pb-1">
              <span className="block px-3.5 py-1.5 text-[10px] uppercase font-mono tracking-wider text-muted/60">
                Tracked Wallets
              </span>
              {wallets.map((wallet) => (
                <button
                  key={wallet.address}
                  type="button"
                  className="flex w-full min-h-[44px] items-center justify-between gap-3 px-3.5 py-2 text-left text-xs sm:text-sm hover:bg-surface-hover transition-colors"
                  onClick={() => {
                    setQuery(wallet.address);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{wallet.label || "Wallet"}</span>
                    <span className="ml-2 font-mono text-xs text-muted">{shortAddress(wallet.address, 4, 4)}</span>
                  </span>
                  <Badge tone={wallet.enabled ? "watching" : "archived"}>{wallet.enabled ? "on" : "off"}</Badge>
                </button>
              ))}
            </div>
          ) : null}

          {tokens.map((token) => {
            const title = tokenTitle(token.symbol, token.name, token.mint);
            const subtitle = tokenSubtitle(token.symbol, token.name);
            const mintShort = shortAddress(token.mint, 4, 4);
            return (
              <div
                key={token.mint}
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-xs sm:text-sm hover:bg-surface-hover transition-colors border-b border-white/[0.04] last:border-b-0"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left min-h-[44px]"
                  onClick={() => {
                    setOpen(false);
                    router.push(`/tokens/${token.mint}`);
                  }}
                >
                  <TokenLogo src={token.imageUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-white">{title}</span>
                    {subtitle ? <span className="block truncate text-[11px] text-muted">{subtitle}</span> : null}
                    <span className="block text-[11px] leading-4 text-muted/80 mt-0.5">
                      <span>Price {token.lastPriceUsd == null ? "—" : compactUsd(token.lastPriceUsd)}</span>
                      {token.entryAt ? (
                        <span>
                          {" · Entry "}
                          <EntryFacts
                            entryAt={token.entryAt}
                            entryPriceUsd={token.entryPriceUsd}
                            entryMcapUsd={token.entryMcapUsd}
                          />
                        </span>
                      ) : null}
                    </span>
                    {title !== mintShort ? (
                      <span className="block truncate font-mono text-[10px] text-muted/50 mt-0.5">{mintShort}</span>
                    ) : null}
                  </span>
                </button>
                <GmgnLink mint={token.mint} />
                <Badge tone={token.status}>{token.status.replace("_", " ")}</Badge>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
