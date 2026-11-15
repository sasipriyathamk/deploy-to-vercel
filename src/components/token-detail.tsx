"use client";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Copy,
  RefreshCw,
} from "lucide-react";
import { usePoll } from "@/components/use-poll";
import { TokenLogo } from "@/components/token-meta";
import { Confidence, Freshness } from "@/components/token-book";
import { SafetyChip } from "@/components/safety-chip";
import { AiShadowBadge } from "@/components/ai-shadow";
import { SocialLinks } from "@/components/social-links";
import { compactUsd, fmtTime, signedPct } from "@/lib/format";
import { tokenTitle } from "@/lib/logic/metadata";
import { SCORE_FACTORS } from "@/lib/logic/score";
import type { TokenDto } from "@/lib/present";
type Check = {
  id: number;
  checkedAt: string | null;
  stage: string;
  passed: boolean | null;
  flags: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
};
export function TokenDetail({ mint }: { mint: string }) {
  const { data, loading, error, reload } = usePoll<{
    token: TokenDto;
    checks: Check[];
  }>(`/api/tokens/${encodeURIComponent(mint)}`, 15000);
  const [actionError, setActionError] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  const token = data?.token;
  async function copy() {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError(
        "Couldn’t copy. Select the mint address below to copy it manually.",
      );
    }
  }
  if (loading && !token)
    return (
      <div className="loading-state" role="status">
        <RefreshCw className="animate-spin" />
        <h1>Loading token research</h1>
      </div>
    );
  if (!token)
    return (
      <div className="empty-state">
        <h1>Token unavailable</h1>
        <p>{error ?? "No record was returned."}</p>
        <button className="outline-control" onClick={() => void reload()}>
          Retry
        </button>
        <Link href="/">Back to workspace</Link>
      </div>
    );
  const checks = data?.checks ?? [];
  const reasons = token.confidenceReasons;
  return (
    <div className="detail-workspace">
      <div className="detail-topline">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> Back to token book
        </Link>
        <button
          className="outline-control"
          onClick={() => void reload()}
          disabled={loading}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {(error || actionError) && (
        <div className="notice error" role="alert">
          {actionError || error}
        </div>
      )}
      <header className="token-detail-header">
        <div className="detail-identity">
          <TokenLogo src={token.imageUrl} size="md" />
          <div>
            <p className="eyebrow">
              TOKEN RESEARCH / {token.status.toUpperCase()}
            </p>
            <h1>{tokenTitle(token.symbol, token.name, mint)}</h1>
            <p>
              {token.name && token.name !== token.symbol
                ? token.name
                : "Solana token"}
            </p>
          </div>
        </div>
        <div className="detail-address">
          <code>{mint}</code>
          <button
            className="icon-control"
            aria-label="Copy mint address"
            onClick={() => void copy()}
          >
            <Copy size={16} />
          </button>
          <span role="status" className="copy-feedback">
            {copied ? "Copied" : ""}
          </span>
        </div>
        <div className="detail-meta">
          <Freshness token={token} />
          <span>{token.venue ?? "Venue unknown"}</span>
          <span>{token.quoteSource ?? "Source unavailable"} · polls every 15s</span>
        </div>
      </header>
      <section className="detail-metrics" aria-label="Market overview">
        <Metric
          label="Market cap"
          value={compactUsd(token.lastMcapUsd)}
          hint="Latest available observation"
        />
        <Metric
          label="Current price"
          value={compactUsd(token.lastPriceUsd)}
          hint="USD per token"
        />
        <Metric
          label={token.entryAt ? "Gain since entry" : "Gain since first alert"}
          value={signedPct(token.gainPct)}
          hint={token.gainBasis === "mcap" ? "Market-cap basis" : "Price basis"}
          tone={token.gainPct}
        />
        <Metric
          label="Liquidity"
          value={compactUsd(token.lastLiqUsd)}
          hint={`1h volume ${compactUsd(token.lastVolH1)}`}
        />
      </section>
      <div className="detail-columns">
        <div className="detail-primary">
          <section className="research-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">OPPORTUNITY EVIDENCE</p>
                <h2>Confidence</h2>
              </div>
              <Confidence value={token.confidence} />
            </div>
            <p className="subtle-copy">
              A rule-based confidence indicator, not a probability of profit.
            </p>
            {reasons.length ? (
              <ul className="evidence-list">
                {reasons.map((r, i) => (
                  <li key={r}>
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="notice">
                There isn’t enough evidence for a confidence explanation yet.
              </p>
            )}
            <div className="evidence-footer">
              <span>Market-cap band: {token.capRegime ?? "Unknown"}</span>
              <span>Peak gain: {signedPct(token.athGainPct)}</span>
            </div>
          </section>
          <ObservationChanges checks={checks} />
          <section className="research-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">OBSERVATION HISTORY</p>
                <h2>Observations</h2>
              </div>
              <span className="count-pill">{checks.length}</span>
            </div>
            <p className="subtle-copy">
              Latest recorded checks, newest first. A check outcome is not a
              trading recommendation.
            </p>
            {checks.length ? (
              <ol className="observation-list">
                {checks.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{c.stage.replaceAll("_", " ")}</strong>
                      <span>{fmtTime(c.checkedAt)}</span>
                    </div>
                    <span className="check-result">
                      {c.passed === true
                        ? "Condition met"
                        : c.passed === false
                          ? "Condition not met"
                          : "Recorded"}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-copy">No checks recorded yet.</p>
            )}
            <details className="plain-details">
              <summary>All checks and recorded evidence</summary>
              {checks.map((c) => (
                <article className="check-record" key={c.id}>
                  <strong>
                    {c.stage.replaceAll("_", " ")} · {fmtTime(c.checkedAt)}
                  </strong>
                  <pre>
                    {JSON.stringify(
                      { flags: c.flags, payload: c.payload },
                      null,
                      2,
                    )}
                  </pre>
                </article>
              ))}
            </details>
          </section>
          <section className="research-panel">
            <p className="eyebrow">BASELINES & TIMESTAMPS</p>
            <h2>Tracking baseline</h2>
            <p className="subtle-copy">
              First discovery, candidate alert, and stored entry are separate
              records. Entry may preserve the first-alert baseline.
            </p>
            <div className="baseline-grid">
              {[
                {
                  label: "First discovered",
                  at: token.firstSeenAt,
                  price: token.firstSeenPriceUsd,
                },
                {
                  label: "First candidate alert",
                  at: token.firstAlertAt,
                  price: token.firstAlertPriceUsd,
                },
                {
                  label: "Stored entry",
                  at: token.entryAt,
                  price: token.entryPriceUsd,
                },
                {
                  label: "Observed peak",
                  at: token.athAt,
                  price: token.athPriceUsd,
                },
              ].map((b) => (
                <div key={b.label}>
                  <span>{b.label}</span>
                  <strong>{compactUsd(b.price)}</strong>
                  <small>{b.at ? fmtTime(b.at) : "Not recorded"}</small>
                </div>
              ))}
            </div>
          </section>
        </div>
        <aside className="detail-secondary">
          <section className="research-panel">
            <p className="eyebrow">SAFETY & DATA</p>
            <h2>Risk checks</h2>
            <SafetyChip token={token} />
            <div className="risk-facts">
              <span>
                Mint authority
                <strong>
                  {token.mintRevoked == null
                    ? "Unknown"
                    : token.mintRevoked
                      ? "Revoked"
                      : "Active"}
                </strong>
              </span>
              <span>
                Freeze authority
                <strong>
                  {token.freezeRevoked == null
                    ? "Unknown"
                    : token.freezeRevoked
                      ? "Revoked"
                      : "Active"}
                </strong>
              </span>
              <span>
                Top holder
                <strong>
                  {token.topHolderPct == null
                    ? "Unknown"
                    : `${token.topHolderPct}%`}
                </strong>
              </span>
            </div>
            <h3>Missing or stale evidence</h3>
            {token.dataQuality.missing.length ? (
              <ul className="missing-list">
                {token.dataQuality.missing.map((m) => (
                  <li key={m}>
                    {m.replace(/^no_/, "Missing ").replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtle-copy">
                No missing fields flagged in this observation.
              </p>
            )}
            <p className="subtle-copy">
              Unchecked safety fields are unknown, not assurances.
            </p>
          </section>
          <section className="research-panel">
            <p className="eyebrow">INDEPENDENT REVIEW</p>
            <h2>AI analysis</h2>
            <p className="subtle-copy">
              A secondary opinion. Keep it separate from market evidence.
            </p>
            <AiShadowBadge verdict={token.aiVerdict} />
          </section>
          <section className="research-panel">
            <p className="eyebrow">EXPLORE THE SOURCES</p>
            <div className="source-links">
              {[
                ["DexScreener", `https://dexscreener.com/solana/${mint}`],
                ["Solscan", `https://solscan.io/token/${mint}`],
                ["RugCheck", `https://rugcheck.xyz/tokens/${mint}`],
              ].map(([label, url]) => (
                <a key={label} href={url} target="_blank" rel="noreferrer">
                  {label}
                  <ArrowUpRight size={16} />
                </a>
              ))}
            </div>
            <SocialLinks links={token.socials} />
          </section>
          <section className="research-panel">
            <details className="plain-details">
              <summary>Rule-based score breakdown · {token.score}/100</summary>
              <p className="subtle-copy">
                This score is separate from opportunity confidence and safety.
              </p>
              {token.scoreBreakdown ? (
                SCORE_FACTORS.map((f) => (
                  <div className="factor-row" key={f.key}>
                    <span>{f.label}</span>
                    <strong>{token.scoreBreakdown![f.key]}</strong>
                  </div>
                ))
              ) : (
                <p>No breakdown recorded.</p>
              )}
            </details>
          </section>
        </aside>
      </div>
    </div>
  );
}
function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: number | null;
}) {
  return (
    <article>
      <span>{label}</span>
      <strong
        className={tone == null ? "" : tone < 0 ? "negative" : "positive"}
      >
        {value}
      </strong>
      <small>{hint}</small>
    </article>
  );
}

function ObservationChanges({ checks }: { checks: Check[] }) {
  const snapshots = [...checks]
    .sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""))
    .flatMap((c) => {
      const raw = c.payload?.snap ?? c.payload;
      if (!raw || typeof raw !== "object" || !("priceUsd" in raw)) return [];
      const snap = raw as Record<string, unknown>;
      return [{ at: c.checkedAt, snap }];
    });
  const [current, previous] = snapshots;
  const comparable =
    current && previous && current.snap.source === previous.snap.source;
  return (
    <section className="research-panel">
      <p className="eyebrow">WHAT CHANGED</p>
      <h2>Snapshot changes</h2>
      {comparable ? (
        <>
          <p className="subtle-copy">
            Two recorded snapshots from{" "}
            {String(current.snap.source ?? "the same source")}.{" "}
            {fmtTime(previous.at)} → {fmtTime(current.at)}. Irregular sampling
            can miss moves between checks.
          </p>
          <div className="change-grid">
            {[
              ["Price", "priceUsd"],
              ["Liquidity", "liqUsd"],
              ["1h volume", "volH1"],
            ].map(([label, key]) => {
              const now = current.snap[key],
                before = previous.snap[key];
              const delta =
                typeof now === "number" &&
                typeof before === "number" &&
                before > 0
                  ? ((now - before) / before) * 100
                  : null;
              return (
                <div key={key}>
                  <span>{label}</span>
                  <strong
                    className={
                      delta == null
                        ? "neutral"
                        : delta < 0
                          ? "negative"
                          : "positive"
                    }
                  >
                    {signedPct(delta)}
                  </strong>
                  <small>vs previous observation</small>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="subtle-copy">
          Two comparable market snapshots are needed to show changes. Missing
          data is not a positive signal.
        </p>
      )}
    </section>
  );
}
