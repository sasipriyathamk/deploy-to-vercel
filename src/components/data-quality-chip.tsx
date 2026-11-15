"use client";

import { useState } from "react";
import type { DataQuality, QualityFlag } from "@/lib/logic/quality";

function flagText(flag: QualityFlag): string {
  switch (flag.code) {
    case "safety_unknown_scored_neutral":
      return `Safety unknown (${flag.unknown.join(", ")})`;
    case "late_entry":
      return `Late entry · ${flag.minutes}m`;
    case "score_capped":
      return `Score capped · raw ${flag.raw}`;
    case "weak_watch_promotion":
      return "Weak watch promotion";
    case "cap_above_low_cap_band":
      return "Cap above the low-cap band";
    case "stale_market_data":
      return flag.ageMinutes == null ? "Stale market data" : `Stale market data · ${flag.ageMinutes}m`;
    case "parse_gap":
      return `Parse gap · ${flag.events}`;
    default:
      return "Flag";
  }
}

export function DataQualityChip({ quality }: { quality?: DataQuality | null }) {
  const [open, setOpen] = useState(false);
  if (!quality) return null;
  const tone =
    quality.score >= 80 ? "border-teal/50 text-teal" : quality.score >= 50 ? "border-amber/70 text-amber" : "border-loss/60 text-loss";
  const missing = quality.missing.map((label) => label.replaceAll("_", " "));
  const flags = quality.flags.map(flagText);
  const summary = [...missing, ...flags].join(", ") || "No missing fields";
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={`inline-flex h-10 items-center rounded-full border bg-transparent px-2.5 text-[11px] font-medium ${tone}`}
        aria-expanded={open}
        aria-label={`Data quality ${quality.score} out of 100. ${summary}`}
        onClick={() => setOpen((value) => !value)}
      >
        DQ {quality.score}
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute top-full left-0 z-30 mt-1 w-56 rounded-lg border border-line bg-paper-2 p-2 text-left text-[11px] font-normal text-ink shadow-lg"
        >
          <span className="block text-muted">Missing fields</span>
          {missing.length === 0 ? <span className="mt-1 block">None</span> : null}
          {missing.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <span className="mt-2 block text-muted">Flags</span>
          {flags.length === 0 ? <span className="mt-1 block">None</span> : null}
          {flags.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {flags.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
