"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { compactUsd, fmtTime, signedPct } from "@/lib/format";
import type { AiShadowVerdict, ShadowStats } from "@/lib/ai/types";

const REASON_COPY: Record<string, string> = {
  missing_env: "AI gateway environment is not set.",
  fomo_auth: "FOMO session is missing or could not be minted.",
  fomo_401: "FOMO rejected the session.",
  fomo_429: "FOMO rate limited the thesis read.",
  fomo_html: "FOMO returned a page instead of JSON.",
  fomo_error: "FOMO thesis read failed.",
  model_error: "The model request failed.",
  invalid_json: "The model reply was not valid JSON.",
  model_unsupported: "The gateway does not serve the configured model.",
};

function verdictTone(verdict: AiShadowVerdict["verdict"]): string {
  if (verdict === "strong") return "watching";
  if (verdict === "avoid") return "rejected_junk";
  if (verdict === "ok") return "candidate";
  return "archived";
}

function positionLabel(thesis: AiShadowVerdict["theses"][number]): string {
  if (thesis.closed) return `Closed · realized ${compactUsd(thesis.realizedUsd)} (${signedPct(thesis.pnlPct)})`;
  return `Holding · ${compactUsd(thesis.sizeUsd)} · unrealized ${compactUsd(thesis.unrealizedUsd)} (${signedPct(thesis.pnlPct)})`;
}

export function AiShadowBadge({
  verdict,
  thesisLimit = 3,
}: {
  verdict: AiShadowVerdict | null;
  thesisLimit?: number;
}) {
  if (!verdict) return <Badge tone="archived">AI (shadow) · not run</Badge>;
  const label =
    verdict.verdict === "unavailable"
      ? "AI (shadow) · unavailable"
      : `AI (shadow) · ${verdict.verdict} · ${verdict.conviction ?? "—"}`;
  const theses = verdict.theses.slice(0, thesisLimit);
  return (
    <details className="min-w-0">
      <summary className="inline-flex min-h-10 cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
        <Badge tone={verdictTone(verdict.verdict)}>{label}</Badge>
      </summary>
      <div className="mt-2 space-y-2 rounded-xl border border-line bg-paper px-3 py-2 text-xs">
        <p className="text-muted">Shadow only. This does not change score, confidence, stage, or archive.</p>
        {verdict.verdict === "unavailable" ? (
          <p>{REASON_COPY[verdict.unavailableReason ?? ""] ?? "Unavailable."}</p>
        ) : (
          <>
            {verdict.narrative ? <p>{verdict.narrative}</p> : null}
            {verdict.bullPoints.length > 0 ? (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Bull points</p>
                <ul className="mt-1 list-disc pl-4">
                  {verdict.bullPoints.map((point, index) => (
                    <li key={`${index}-${point}`}>{point}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted">Red flags</p>
              {verdict.redFlags.length === 0 ? <p className="mt-1 text-muted">None noted</p> : null}
              {verdict.redFlags.length > 0 ? (
                <ul className="mt-1 list-disc pl-4">
                  {verdict.redFlags.map((flag, index) => (
                    <li key={`${index}-${flag}`}>{flag}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            {verdict.invalidation ? (
              <p>
                <span className="text-muted">Invalidation · </span>
                {verdict.invalidation}
              </p>
            ) : null}
            {verdict.holderSummary ? (
              <p>
                <span className="text-muted">Holders · </span>
                {verdict.holderSummary}
              </p>
            ) : null}
            {verdict.reasoning ? <p>{verdict.reasoning}</p> : null}
          </>
        )}
        {theses.length > 0 ? (
          <div className="space-y-2 border-t border-line pt-2">
            {theses.map((thesis) => (
              <article key={`${thesis.who}-${thesis.at}-${thesis.text.slice(0, 24)}`}>
                <p className="text-muted">
                  @{thesis.who} · {positionLabel(thesis)} · {fmtTime(thesis.at)}
                </p>
                <p className="mt-0.5">{thesis.text}</p>
              </article>
            ))}
          </div>
        ) : null}
        <p className="text-[10px] text-muted">
          {fmtTime(verdict.createdAt)}
          {verdict.model ? ` · ${verdict.model}` : ""}
          {verdict.promptTokens != null ? ` · in ${verdict.promptTokens}` : ""}
          {verdict.completionTokens != null ? ` · out ${verdict.completionTokens}` : ""}
          {verdict.costUsd != null ? ` · ${compactUsd(verdict.costUsd)}` : ""}
        </p>
      </div>
    </details>
  );
}

function cell(value: number | null): string {
  return signedPct(value);
}

export function AiShadowStats() {
  const [data, setData] = useState<ShadowStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    const load = () => {
      if (inFlightRef.current) return;
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      inFlightRef.current = true;

      void fetch("/api/pipeline/ai-verdicts", { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const body = (await response.json()) as ShadowStats & { error?: string };
          if (controller.signal.aborted) return;
          if (!response.ok) throw new Error(body.error || "Request failed");
          setData((prev) => (JSON.stringify(prev) === JSON.stringify(body) ? prev : body));
          setError(null);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          setError(caught instanceof Error ? caught.message : "Request failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            inFlightRef.current = false;
          }
        });
    };

    const kickoff = window.setTimeout(load, 0);
    const timer = window.setInterval(load, 30_000);

    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
      if (abortRef.current) abortRef.current.abort();
      inFlightRef.current = false;
    };
  }, []);

  return (
    <section className="rounded-2xl border border-line bg-paper-2 p-3">
      <h2 className="text-sm font-medium">AI shadow check</h2>
      <p className="mt-1 text-xs text-muted">
        Latest strong, ok, and avoid verdicts against current gain and ATH gain since first alert. Not used in score,
        confidence, stage, or archive.
      </p>
      {error ? <p className="mt-2 text-sm text-loss">{error}</p> : null}
      {data ? (
        <>
          <p className="mt-2 text-xs text-muted">
            Model calls today {data.usedToday}/{data.dailyCap}
            {data.configured ? "" : " · gateway not configured"}
            {data.fomoConfigured ? "" : " · FOMO session not configured"}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Shadow verdicts compared with gain since first alert</caption>
              <thead className="text-[10px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">Verdict</th>
                  <th className="py-1 pr-3 font-medium">Tokens</th>
                  <th className="py-1 pr-3 font-medium">With gain</th>
                  <th className="py-1 pr-3 font-medium">Avg gain</th>
                  <th className="py-1 pr-3 font-medium">Median gain</th>
                  <th className="py-1 pr-3 font-medium">Avg ATH</th>
                  <th className="py-1 font-medium">Median ATH</th>
                </tr>
              </thead>
              <tbody>
                {data.buckets.map((bucket) => (
                  <tr key={bucket.verdict} className="border-t border-line">
                    <td className="py-1 pr-3">{bucket.verdict}</td>
                    <td className="tabular py-1 pr-3">{bucket.n}</td>
                    <td className="tabular py-1 pr-3">{bucket.withGain}</td>
                    <td className="tabular py-1 pr-3">{cell(bucket.avgGainPct)}</td>
                    <td className="tabular py-1 pr-3">{cell(bucket.medianGainPct)}</td>
                    <td className="tabular py-1 pr-3">{cell(bucket.avgAthGainPct)}</td>
                    <td className="tabular py-1">{cell(bucket.medianAthGainPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : error ? null : (
        <p className="mt-2 text-sm text-muted">Loading shadow stats…</p>
      )}
    </section>
  );
}
