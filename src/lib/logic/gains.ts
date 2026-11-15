export type EntryFields = {
  entryAt: Date | null;
  entryPriceUsd: number | null;
  entryMcapUsd: number | null;
};

export type EntryQuote = {
  at: Date;
  priceUsd: number | null;
  mcapUsd: number | null;
};

/** First stamp wins. Later calls, including revive, leave the original entry in place. */
export function stampEntry(current: EntryFields, next: EntryQuote): EntryFields {
  if (current.entryAt) return current;
  return {
    entryAt: next.at,
    entryPriceUsd: positive(next.priceUsd),
    entryMcapUsd: positive(next.mcapUsd),
  };
}

export type FirstAlertFields = {
  firstAlertAt: Date | null;
  firstAlertPriceUsd: number | null;
  firstAlertMcapUsd: number | null;
};

/**
 * Stamped once, the moment a token first becomes a candidate.
 * Rechecks, archive, and revive must pass the existing stamp back through here
 * and keep the original price, mcap, and time.
 */
export function stampFirstAlert(current: FirstAlertFields, next: EntryQuote): FirstAlertFields {
  if (current.firstAlertAt) return current;
  return {
    firstAlertAt: next.at,
    firstAlertPriceUsd: positive(next.priceUsd),
    firstAlertMcapUsd: positive(next.mcapUsd),
  };
}

/**
 * Watching entry is the candidate first-alert when it is still empty.
 * A token that never became a candidate has no first-alert, so this leaves entry empty.
 * An entry that is already set is returned unchanged.
 */
export function entryFromFirstAlert(input: EntryFields & FirstAlertFields): EntryFields {
  if (input.entryAt) {
    return {
      entryAt: input.entryAt,
      entryPriceUsd: input.entryPriceUsd,
      entryMcapUsd: input.entryMcapUsd,
    };
  }
  if (!input.firstAlertAt) {
    return {
      entryAt: null,
      entryPriceUsd: input.entryPriceUsd,
      entryMcapUsd: input.entryMcapUsd,
    };
  }
  return {
    entryAt: input.firstAlertAt,
    entryPriceUsd: input.firstAlertPriceUsd,
    entryMcapUsd: input.firstAlertMcapUsd,
  };
}

/** Entry wins once watching is stamped. Until then, gains use the candidate first-alert. */
export function performanceAnchor(input: EntryFields & FirstAlertFields): {
  at: Date;
  priceUsd: number | null;
  mcapUsd: number | null;
} | null {
  if (input.entryAt) {
    return { at: input.entryAt, priceUsd: input.entryPriceUsd, mcapUsd: input.entryMcapUsd };
  }
  if (!input.firstAlertAt) return null;
  return {
    at: input.firstAlertAt,
    priceUsd: input.firstAlertPriceUsd,
    mcapUsd: input.firstAlertMcapUsd,
  };
}

export function positive(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function gainPct(current: number | null | undefined, entry: number | null | undefined): number | null {
  const now = positive(current);
  const base = positive(entry);
  if (now == null || base == null) return null;
  return Math.round((((now - base) / base) * 100) * 1e6) / 1e6;
}

export type GainResult = {
  gainPct: number | null;
  basis: "price" | "mcap" | null;
};

/** Price gain when both prices exist. Otherwise mcap gain, labeled so the UI can say so. */
export function resolveGain(input: {
  lastPrice: number | null;
  entryPrice: number | null;
  lastMcap: number | null;
  entryMcap: number | null;
}): GainResult {
  const priceGain = gainPct(input.lastPrice, input.entryPrice);
  if (priceGain != null) return { gainPct: priceGain, basis: "price" };
  const mcapGain = gainPct(input.lastMcap, input.entryMcap);
  if (mcapGain != null) return { gainPct: mcapGain, basis: "mcap" };
  return { gainPct: null, basis: null };
}

export type AthState = {
  athPriceUsd: number | null;
  athMcapUsd: number | null;
  athAt: Date | null;
  athGainPct: number | null;
};

/**
 * ATH is the high since entry_at only. Prices observed before entry are ignored.
 * ath_gain_pct uses price when the entry was priced, otherwise mcap.
 */
export function updateAth(input: {
  entryAt: Date | null;
  entryPriceUsd: number | null;
  entryMcapUsd: number | null;
  athPriceUsd: number | null;
  athMcapUsd: number | null;
  athAt: Date | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  observedAt: Date;
}): AthState {
  const entryPrice = positive(input.entryPriceUsd);
  const entryMcap = positive(input.entryMcapUsd);
  if (!input.entryAt || (entryPrice == null && entryMcap == null)) {
    return {
      athPriceUsd: input.athPriceUsd,
      athMcapUsd: input.athMcapUsd,
      athAt: input.athAt,
      athGainPct: null,
    };
  }

  let athPrice = positive(input.athPriceUsd);
  let athMcap = positive(input.athMcapUsd);
  let athAt = input.athAt;

  if (input.observedAt >= input.entryAt) {
    const price = positive(input.priceUsd);
    const mcap = positive(input.mcapUsd);
    if (price != null && (athPrice == null || price > athPrice)) {
      athPrice = price;
      athAt = input.observedAt;
    }
    if (mcap != null && (athMcap == null || mcap > athMcap)) {
      athMcap = mcap;
      if (athAt == null) athAt = input.observedAt;
    }
  }

  const athGain =
    entryPrice != null ? gainPct(athPrice, entryPrice) : gainPct(athMcap, entryMcap);

  return {
    athPriceUsd: athPrice,
    athMcapUsd: athMcap,
    athAt,
    athGainPct: athGain,
  };
}

export function drawdownFromAthPct(lastPrice: number | null, athPrice: number | null): number | null {
  const last = positive(lastPrice);
  const ath = positive(athPrice);
  if (last == null || ath == null) return null;
  return ((last - ath) / ath) * 100;
}

export type ReviveState = EntryFields & {
  status: string;
  reviveCount: number;
  revivedAt: Date | null;
};

/** Revive never rewrites entry_at / entry prices. */
export function applyRevive<T extends ReviveState>(row: T, at: Date): T {
  return {
    ...row,
    status: "watching",
    reviveCount: row.reviveCount + 1,
    revivedAt: at,
    entryAt: row.entryAt,
    entryPriceUsd: row.entryPriceUsd,
    entryMcapUsd: row.entryMcapUsd,
  };
}
