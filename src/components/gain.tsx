import { signedPct } from "@/lib/format";

export function Gain({
  value,
  basis,
  className = "",
}: {
  value: number | null;
  basis?: string | null;
  className?: string;
}) {
  if (value == null) return <span className={`text-muted ${className}`}>—</span>;
  const tone = value > 0 ? "text-gain" : value < 0 ? "text-loss" : "text-ink";
  return (
    <span className={`tabular font-medium ${tone} ${className}`}>
      {signedPct(value)}
      {basis === "mcap" ? <span className="ml-1 text-[10px] font-normal text-muted">mcap</span> : null}
    </span>
  );
}
