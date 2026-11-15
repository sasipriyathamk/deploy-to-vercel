import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  watching: "bg-gain/15 text-gain",
  candidate: "bg-amber/15 text-amber",
  archived: "bg-chip text-muted",
  seen: "bg-chip text-ink",
  rejected_junk: "bg-loss/15 text-loss",
  neutral: "bg-chip text-ink",
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        tones[tone] ?? tones.neutral,
        className,
      )}
      {...props}
    />
  );
}
