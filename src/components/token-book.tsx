"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  ArrowUpRight,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { TokenLogo } from "@/components/token-meta";
import { SafetyChip } from "@/components/safety-chip";
import { compactUsd, fmtAge, signedPct } from "@/lib/format";
import {
  matchesBookQuery,
  nextSort,
  sortBook,
  type SortKey,
  type SortState,
} from "@/lib/logic/book";
import { tokenTitle } from "@/lib/logic/metadata";
import { safetyChip } from "@/lib/logic/safety";
import type { TokenDto } from "@/lib/present";

const sorts: { key: SortKey; label: string }[] = [
  { key: "latest", label: "Latest discovered" },
  { key: "confidence", label: "Confidence" },
  { key: "gain", label: "Current gain" },
  { key: "ath", label: "Peak gain" },
  { key: "mc", label: "Market cap" },
  { key: "volH1", label: "1h volume" },
];
export function TokenBook({
  tokens,
}: {
  tokens: TokenDto[];
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({
    key: "latest",
    direction: "desc",
  });
  const [filters, setFilters] = useState(false);
  const [cap, setCap] = useState("all");
  const [safety, setSafety] = useState("all");
  const visible = useMemo(
    () =>
      sortBook(
        tokens.filter(
          (t) =>
            matchesBookQuery(t, query) &&
            (cap === "all" || t.capRegime === cap) &&
            (safety === "all" || safetyChip(t).tone === safety),
        ),
        sort,
        () => null,
      ),
    [tokens, query, cap, safety, sort],
  );
  function reset() {
    setQuery("");
    setCap("all");
    setSafety("all");
  }
  return (
    <section className="book-panel" aria-label="Watching token book">
      <div className="book-tools">
        <label className="book-search">
          <Search size={17} aria-hidden />
          <span className="sr-only">Filter loaded tokens</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a token in this view…"
          />
          {query && (
            <button
              aria-label="Clear token filter"
              onClick={() => setQuery("")}
            >
              <X size={16} />
            </button>
          )}
        </label>
        <div className="sort-controls">
          <label>
            <span className="sr-only">Sort tokens</span>
            <select
              aria-label="Sort tokens"
              value={sort?.key ?? "latest"}
              onChange={(e) =>
                setSort(nextSort(null, e.target.value as SortKey))
              }
            >
              {sorts.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-control"
            aria-label={`Sort ${sort?.direction === "desc" ? "ascending" : "descending"}`}
            onClick={() =>
              sort &&
              setSort({
                ...sort,
                direction: sort.direction === "desc" ? "asc" : "desc",
              })
            }
          >
            <ArrowDownUp size={17} />
          </button>
          <button
            className="outline-control"
            aria-expanded={filters}
            onClick={() => setFilters(!filters)}
          >
            <SlidersHorizontal size={16} /> Filters
            {cap !== "all" || safety !== "all" ? " · active" : ""}
          </button>
        </div>
      </div>
      {filters && (
        <div className="filter-panel">
          <label>
            Market cap
            <select
              aria-label="Market cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            >
              <option value="all">All market caps</option>
              <option value="fresh">Under $1m</option>
              <option value="mid">$1m–$5m</option>
              <option value="extended">$5m and above</option>
            </select>
          </label>
          <label>
            Safety assessment
            <select
              aria-label="Safety assessment"
              value={safety}
              onChange={(e) => setSafety(e.target.value)}
            >
              <option value="all">All assessments</option>
              <option value="clear">Clear</option>
              <option value="flag">One flag</option>
              <option value="risky">Risky</option>
              <option value="unknown">Not checked</option>
            </select>
          </label>
          <button className="text-control" onClick={reset}>
            Reset filters
          </button>
        </div>
      )}
      <div className="book-caption">
        <span aria-live="polite">{visible.length} tokens in this view</span>
      </div>
      {!visible.length ? (
        <div className="empty-state">
          <Search size={28} />
          <h3>{tokens.length ? "No matching tokens" : "Nothing here yet"}</h3>
          <p>
            {tokens.length
              ? "Try another name or loosen your filters."
              : "Discovered tokens will appear here."}
          </p>
          {tokens.length > 0 && (
            <button className="outline-control" onClick={reset}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="desktop-book">
            <table>
              <caption className="sr-only">Token market observations</caption>
              <thead>
                <tr>
                  <th>Token / discovered</th>
                  <th>Market cap</th>
                  <th>Current gain</th>
                  <th>1h volume</th>
                  <th>Confidence</th>
                  <th>Safety / checked</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => (
                  <tr key={t.mint}>
                    <td>
                      <TokenIdentity token={t} />
                    </td>
                    <td>{compactUsd(t.lastMcapUsd)}</td>
                    <td>
                      <Return value={t.gainPct} />
                      <small>Peak {signedPct(t.athGainPct)}</small>
                    </td>
                    <td>{compactUsd(t.lastVolH1)}</td>
                    <td>
                      <Confidence value={t.confidence} />
                      <small className="reason-preview">
                        {t.confidenceReasons[0] ?? "Awaiting evidence"}
                      </small>
                    </td>
                    <td>
                      <SafetyChip token={t} />
                      <small>
                        <Freshness token={t} />
                      </small>
                    </td>
                    <td>
                      <Link
                        className="icon-control"
                        aria-label={`View ${tokenTitle(t.symbol, t.name, t.mint)}`}
                        href={`/tokens/${t.mint}`}
                      >
                        <ArrowUpRight size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-book">
            {visible.map((t) => (
              <article className="token-card" key={t.mint}>
                <div className="card-top">
                  <TokenIdentity token={t} />
                  <Return value={t.gainPct} />
                </div>
                <div className="card-metrics">
                  <div>
                    <span>Market cap</span>
                    <strong>{compactUsd(t.lastMcapUsd)}</strong>
                  </div>
                  <div>
                    <span>1h volume</span>
                    <strong>{compactUsd(t.lastVolH1)}</strong>
                  </div>
                  <div>
                    <span>Confidence</span>
                    <Confidence value={t.confidence} />
                  </div>
                </div>
                <p className="card-reason">
                  {t.confidenceReasons[0] ?? "More market evidence is needed."}
                </p>
                <div className="card-bottom">
                  <SafetyChip token={t} />
                  <Freshness token={t} />
                  <Link
                    aria-label={`Review ${tokenTitle(t.symbol, t.name, t.mint)}`}
                    href={`/tokens/${t.mint}`}
                  >
                    Review <ArrowUpRight size={15} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
export function Freshness({
  token,
}: {
  token: Pick<TokenDto, "lastCheckedAt" | "dataQuality" | "lastPriceUsd" | "lastMcapUsd">;
}) {
  const unavailable = token.lastPriceUsd == null && token.lastMcapUsd == null;
  const stale =
    unavailable || !token.lastCheckedAt ||
    token.dataQuality.missing.includes("stale_market_data");
  return (
    <span className={stale ? "freshness stale" : "freshness"}>
      <i />
      {unavailable ? "Quote unavailable" : token.lastCheckedAt
        ? `Checked ${fmtAge(token.lastCheckedAt)} ago`
        : "Not checked"}
      {stale && !unavailable ? " · stale" : ""}
    </span>
  );
}
export function Confidence({ value }: { value: number | null }) {
  return (
    <span className="confidence-value">
      <strong>{value ?? "—"}</strong>
      <span>/100</span>
      <span className="confidence-track" aria-hidden>
        <i style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
      </span>
    </span>
  );
}
function Return({ value }: { value: number | null }) {
  return (
    <strong
      className={
        value == null
          ? "return neutral"
          : value < 0
            ? "return negative"
            : "return positive"
      }
    >
      {signedPct(value)}
    </strong>
  );
}
function TokenIdentity({ token: t }: { token: TokenDto }) {
  return (
    <div className="token-identity">
      <TokenLogo src={t.imageUrl} size="md" />
      <div>
        <Link href={`/tokens/${t.mint}`} className="token-title">
          {tokenTitle(t.symbol, t.name, t.mint)}
        </Link>
        <small>
          {t.firstSeenAt
            ? `Discovered ${fmtAge(t.firstSeenAt)} ago`
            : "Discovery time unknown"}
        </small>
      </div>
    </div>
  );
}
