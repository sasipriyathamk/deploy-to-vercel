/** Display clock for the tracker. Asia/Calcutta is the IANA zone Asia/Kolkata (IST, UTC+5:30). */
export const DISPLAY_TIME_ZONE = "Asia/Kolkata";
export const DISPLAY_TIME_LABEL = "IST";

export function shortAddress(value: string | null | undefined, head = 4, tail = 4): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function groupedDollars(abs: number): string {
  const rounded = Math.round(abs * 100) / 100;
  const whole = Math.abs(rounded - Math.round(rounded)) < 0.001;
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function fixedTrim(value: number, maxDigits: number, minDigits: number): string {
  const text = value.toFixed(maxDigits);
  const dot = text.indexOf(".");
  if (dot < 0) return text;
  const whole = text.slice(0, dot);
  const frac = text.slice(dot + 1).replace(/0+$/, "");
  const kept = frac.length < minDigits ? text.slice(dot + 1, dot + 1 + minDigits) : frac;
  return kept.length > 0 ? `${whole}.${kept}` : whole;
}

/** Decimal form for sub-cent prices. Never scientific notation. */
function plainSmall(abs: number): string {
  const places = Math.min(18, Math.max(2, -Math.floor(Math.log10(abs)) + 4));
  const text = abs.toFixed(places).replace(/0+$/, "").replace(/\.$/, "");
  if (text !== "0") return text;
  return abs.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * USD for price, market cap, liquidity, and volume.
 * Examples: $1,280 and $12.80k. Null stays a dash so empty metrics are not fake zeroes.
 */
export function compactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs === 0) return `${sign}$0.00`;
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1e3).toFixed(2)}k`;
  if (abs >= 1_000) return `${sign}$${groupedDollars(abs)}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${fixedTrim(abs, 4, 2)}`;
  return `${sign}$${plainSmall(abs)}`;
}

export function signedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/** SOL spent on a buy. This is a token quantity, not a USD price. */
export function fmtSol(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 10 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${abs.toFixed(digits)} SOL`;
}

export function fmtSolSpent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "SOL spent missing";
  return `${fmtSol(value)} spent`;
}

export function fmtAge(from: string | Date | null | undefined, now = Date.now()): string {
  if (!from) return "missing";
  const time = new Date(from).getTime();
  if (Number.isNaN(time)) return "missing";
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function clockParts(date: Date): { day: string; month: string; year: string; hour: string; minute: string } | null {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const day = pick("day");
  const month = pick("month");
  const year = pick("year");
  const hour = pick("hour");
  const minute = pick("minute");
  if (!day || !month || !year || !hour || !minute) return null;
  return { day, month, year, hour, minute };
}

/** Readable Asia/Calcutta time with an IST label. Unknown values say missing, not a blank or a raw ISO string. */
export function fmtTime(value: string | Date | null | undefined): string {
  if (value == null || value === "") return "missing";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "missing";
  const parts = clockParts(date);
  if (!parts) return "missing";
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${DISPLAY_TIME_LABEL}`;
}

export function fmtStamp(value: string | Date | null | undefined, now = Date.now()): string {
  const clock = fmtTime(value);
  if (clock === "missing") return "missing";
  const age = fmtAge(value, now);
  return age === "missing" ? clock : `${clock} (${age})`;
}

export type EntryParts =
  | { state: "empty" }
  | { state: "bad-time" }
  | { state: "set"; price: string; mcap: string; at: string };

/** Entry is present only when entryAt was stamped. Missing price or mcap stays labeled, never invented. */
export function entryParts(entry: {
  entryAt?: string | Date | null;
  entryPriceUsd?: number | null;
  entryMcapUsd?: number | null;
}): EntryParts {
  if (entry.entryAt == null || entry.entryAt === "") return { state: "empty" };
  const at = fmtTime(entry.entryAt);
  if (at === "missing") return { state: "bad-time" };
  return {
    state: "set",
    price: entry.entryPriceUsd == null ? "price missing" : compactUsd(entry.entryPriceUsd),
    mcap: entry.entryMcapUsd == null ? "mcap missing" : `mcap ${compactUsd(entry.entryMcapUsd)}`,
    at,
  };
}

export function entrySummary(entry: {
  entryAt?: string | Date | null;
  entryPriceUsd?: number | null;
  entryMcapUsd?: number | null;
}): string {
  const parts = entryParts(entry);
  if (parts.state === "empty") return "No entry yet";
  if (parts.state === "bad-time") return "Entry time missing";
  return `${parts.price} · ${parts.mcap} · ${parts.at}`;
}

const MONEY_FLAG_KEY = /(price|mcap|liq|vol|fdv)/i;

export function formatFlagValue(key: string, value: unknown): string {
  if (value == null || value === "") return "missing";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" && Number.isFinite(value) && MONEY_FLAG_KEY.test(key)) return compactUsd(value);
  return String(value);
}

export function holdingLabel(value: boolean | null | undefined): string {
  if (value === true) return "Holding";
  if (value === false) return "Sold";
  return "Unknown";
}
