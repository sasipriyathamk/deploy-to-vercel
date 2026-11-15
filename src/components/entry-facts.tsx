import { entryParts } from "@/lib/format";

export function EntryFacts({
  entryAt,
  entryPriceUsd,
  entryMcapUsd,
  stacked = false,
}: {
  entryAt?: string | Date | null;
  entryPriceUsd?: number | null;
  entryMcapUsd?: number | null;
  stacked?: boolean;
}) {
  const parts = entryParts({ entryAt, entryPriceUsd, entryMcapUsd });
  if (parts.state === "empty") return <span>No entry yet</span>;
  if (parts.state === "bad-time") return <span>Entry time missing</span>;
  if (!stacked) {
    return (
      <span>
        {parts.price} · {parts.mcap} · {parts.at}
      </span>
    );
  }
  return (
    <span>
      <span className="block">{parts.price}</span>
      <span className="block text-[11px] font-normal text-muted">{parts.mcap}</span>
      <span className="block text-[11px] font-normal text-muted">{parts.at}</span>
    </span>
  );
}
