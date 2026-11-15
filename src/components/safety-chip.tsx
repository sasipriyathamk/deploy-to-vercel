import { safetyChip, type SafetyInput } from "@/lib/logic/safety";

const TONE_CLASS = {
  clear: "border-gain/50 text-gain",
  flag: "border-amber/70 text-amber",
  risky: "border-loss/60 text-loss",
  unknown: "border-line text-muted",
} as const;

export function SafetyChip({ token }: { token: SafetyInput }) {
  const chip = safetyChip(token);
  return (
    <span
      className={`inline-flex h-7 items-center rounded-full border px-2 text-[11px] font-medium ${TONE_CLASS[chip.tone]}`}
      title={chip.flags.length > 0 ? chip.flags.join(", ") : chip.label}
    >
      {chip.label}
    </span>
  );
}
