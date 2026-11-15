"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  TrendingUp,
  ChartNoAxesColumnIncreasing,
} from "lucide-react";
import { TokenLogo } from "@/components/token-meta";
import { Freshness } from "@/components/token-book";
import { compactUsd, signedPct } from "@/lib/format";
import { tokenTitle } from "@/lib/logic/metadata";
import type { TokenDto } from "@/lib/present";

type Ranking = "gain" | "volume";
export function TrendingRail({gainers,volume,loading}:{gainers:TokenDto[];volume:TokenDto[];loading:boolean}) {
  const [ranking, setRanking] = useState<Ranking>("gain");
  return (
    <section className="leaders-section" aria-labelledby="leaders-heading">
      <div className="leaders-heading">
        <div>
          <h1 id="leaders-heading">
            {ranking === "gain" ? "Current gainers" : "Leading by volume"}
          </h1>
        </div>
        <div
          className="ranking-toggle"
          role="group"
          aria-label="Rank top tokens by"
        >
          <button
            aria-pressed={ranking === "gain"}
            onClick={() => setRanking("gain")}
          >
            <TrendingUp size={15} aria-hidden /> Trending
          </button>
          <button
            aria-pressed={ranking === "volume"}
            onClick={() => setRanking("volume")}
          >
            <ChartNoAxesColumnIncreasing size={15} aria-hidden /> 1h volume
          </button>
        </div>
      </div>
      <RankedTokens key={ranking} tokens={ranking === "gain" ? gainers : volume} ranking={ranking} loading={loading}/>
    </section>
  );
}
function RankedTokens({tokens,ranking,loading}: {
  tokens: TokenDto[]; ranking: Ranking; loading:boolean;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(true),
    [end, setEnd] = useState(true);
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    function measure() {
      if (!element) return;
      setStart(element.scrollLeft <= 2);
      setEnd(
        element.scrollLeft + element.clientWidth >= element.scrollWidth - 2,
      );
    }
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [tokens]);
  function scroll(direction: number) {
    const e = rail.current;
    if (e)
      e.scrollBy({
        left: direction * e.clientWidth * 0.8,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }
  return (
    <>
      <div className="leaders-caption">
        <p>
          {ranking === "gain"
            ? "Ranked by current gain from the stored entry or first-alert baseline."
            : "Ranked by reported 1h volume, not price gain."}{" "}

        </p>
        <div className="rail-arrows">
          <button
            aria-label="Previous top tokens"
            onClick={() => scroll(-1)}
            disabled={start}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            aria-label="Next top tokens"
            onClick={() => scroll(1)}
            disabled={end}
          >
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
      {loading && !tokens.length ? (
        <div
          className="rail-loading"
          role="status"
          aria-label="Loading top tokens"
        >
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="leader-skeleton" />
          ))}
          <span className="sr-only">Loading top tokens</span>
        </div>
      ) : !tokens.length ? (
        (
          <div className="rail-empty">
            {ranking === "gain"
              ? "No positive gains recorded in this book yet."
              : "No positive 1h volume recorded in this book yet."}{" "}
            New observations will appear here.
          </div>
        )
      ) : (
        <div
          ref={rail}
          className="leaders-rail"
          role="region"
          aria-label={
            ranking === "gain"
              ? "Top 10 current gainers"
              : "Top 10 by 1h volume"
          }
          tabIndex={0}
        >
          {tokens.map((t, i) => (
            <Link
              key={t.mint}
              href={`/tokens/${t.mint}`}
              className="leader-card"
              aria-label={`Rank ${i + 1}: ${tokenTitle(t.symbol, t.name, t.mint)}, ${ranking === "gain" ? signedPct(t.gainPct) : compactUsd(t.lastVolH1)}`}
            >
              <div className="leader-top">
                <span className="leader-rank">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <ArrowUpRight size={15} aria-hidden />
              </div>
              <div className="leader-identity">
                <TokenLogo src={t.imageUrl} />
                <div>
                  <strong>{tokenTitle(t.symbol, t.name, t.mint)}</strong>
                  <small>
                    {t.name && t.name !== t.symbol ? t.name : "Solana token"}
                  </small>
                </div>
              </div>
              <div className="leader-value">
                <strong className={ranking === "gain" ? "positive" : ""}>
                  {ranking === "gain"
                    ? signedPct(t.gainPct)
                    : compactUsd(t.lastVolH1)}
                </strong>
                <span>{ranking === "gain" ? "current gain" : "1h volume"}</span>
              </div>
              <div className="leader-secondary">
                <span>{ranking === "gain" ? "1h volume" : "Current gain"}</span>
                <b
                  className={
                    ranking === "volume" && (t.gainPct ?? 0) < 0
                      ? "negative"
                      : ""
                  }
                >
                  {ranking === "gain"
                    ? compactUsd(t.lastVolH1)
                    : signedPct(t.gainPct)}
                </b>
              </div>
              <Freshness token={t} />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
