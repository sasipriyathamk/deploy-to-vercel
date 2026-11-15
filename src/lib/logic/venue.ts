export const PROGRAMS = {
  pumpFun: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpAmm: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  raydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydiumCpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
} as const;

export type VenueGuess = { venue: string | null; graduated: boolean };

export function venueFromPrograms(programs: string[], source?: string | null): VenueGuess {
  const ids = new Set(programs);
  const src = (source ?? "").toUpperCase();
  const has = (id: string, label: string) => ids.has(id) || src.includes(label);

  if (has(PROGRAMS.pumpAmm, "PUMP_AMM") || src.includes("PUMPSWAP")) {
    return { venue: "pump.amm", graduated: true };
  }
  if (has(PROGRAMS.raydiumV4, "RAYDIUM") || ids.has(PROGRAMS.raydiumCpmm) || ids.has(PROGRAMS.raydiumClmm)) {
    return { venue: "raydium", graduated: true };
  }
  if (has(PROGRAMS.meteoraDlmm, "METEORA")) return { venue: "meteora", graduated: true };
  if (src.includes("ORCA")) return { venue: "orca", graduated: true };
  if (has(PROGRAMS.jupiterV6, "JUPITER")) return { venue: "jupiter", graduated: false };
  if (has(PROGRAMS.pumpFun, "PUMP")) return { venue: "pump.fun", graduated: false };
  return { venue: null, graduated: false };
}

export function venueFromDex(dexId: string | null): VenueGuess | null {
  if (!dexId) return null;
  const id = dexId.toLowerCase();
  if (id.includes("pump") && (id.includes("swap") || id.includes("amm"))) {
    return { venue: "pump.amm", graduated: true };
  }
  if (id.includes("pump")) return { venue: "pump.fun", graduated: false };
  if (id.includes("raydium")) return { venue: "raydium", graduated: true };
  if (id.includes("meteora")) return { venue: "meteora", graduated: true };
  if (id.includes("orca") || id.includes("whirlpool")) return { venue: "orca", graduated: true };
  if (id.includes("jupiter")) return { venue: "jupiter", graduated: false };
  return { venue: dexId, graduated: true };
}

/** A later bonding-curve quote does not demote a token that already graduated. */
export function mergeVenue(prevVenue: string | null, prevGraduated: boolean, dexId: string | null): VenueGuess {
  const mapped = venueFromDex(dexId);
  if (!mapped) return { venue: prevVenue, graduated: prevGraduated };
  if (prevGraduated && !mapped.graduated) return { venue: prevVenue, graduated: true };
  return { venue: mapped.venue, graduated: prevGraduated || mapped.graduated };
}
