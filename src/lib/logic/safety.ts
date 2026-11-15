export type SafetyTone = "clear" | "flag" | "risky" | "unknown";

export type SafetyChip = {
  tone: SafetyTone;
  label: "Clear" | "1 flag" | "Risky" | "Not checked";
  flags: string[];
};

export type SafetyInput = {
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  topHolderPct: number | null;
  rugcheckNormalised: number | null;
};

/**
 * Safety is a display chip over checks the book already stores.
 * RugCheck normalised score is risk (higher = riskier), matching the scorer.
 */
export function safetyChip(input: SafetyInput): SafetyChip {
  const checked =
    input.mintRevoked != null ||
    input.freezeRevoked != null ||
    input.topHolderPct != null ||
    input.rugcheckNormalised != null;
  if (!checked) return { tone: "unknown", label: "Not checked", flags: [] };

  const flags: string[] = [];
  if (input.mintRevoked === false) flags.push("Mint authority");
  if (input.freezeRevoked === false) flags.push("Freeze authority");
  if (input.topHolderPct != null && input.topHolderPct > 50) flags.push("Concentrated holder");
  if (input.rugcheckNormalised != null && input.rugcheckNormalised > 60) flags.push("RugCheck elevated");

  if (flags.length === 0) return { tone: "clear", label: "Clear", flags: [] };
  const severe = input.rugcheckNormalised != null && input.rugcheckNormalised > 80;
  if (flags.length === 1 && !severe) return { tone: "flag", label: "1 flag", flags };
  return { tone: "risky", label: "Risky", flags };
}
