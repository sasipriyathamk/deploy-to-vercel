/** Lower runs first. Parse of new wallet txs, then T0, then due rechecks. */
export function jobPriority(type: string): number {
  switch (type) {
    case "parse":
    case "parse_rpc":
      return 0;
    case "enrich_t0":
      return 1;
    case "recheck_t5":
    case "recheck_t15":
    case "recheck_t60":
      return 2;
    case "hold_check":
      return 3;
    default:
      return 9;
  }
}

export const JOB_PRIORITY_SQL = `CASE type
  WHEN 'parse' THEN 0
  WHEN 'parse_rpc' THEN 0
  WHEN 'enrich_t0' THEN 1
  WHEN 'recheck_t5' THEN 2
  WHEN 'recheck_t15' THEN 2
  WHEN 'recheck_t60' THEN 2
  WHEN 'hold_check' THEN 3
  ELSE 9
END`;

/**
 * `last_signature` means every newer signature is already stored.
 * A full walk advances it to the newest signature. A partial walk keeps the old
 * cursor and resumes from the oldest signature stored in this walk.
 */
export function planSignatureCheckpoint(input: {
  previousCursor: string | null;
  newest: string | null;
  oldest: string | null;
  exhausted: boolean;
}): { lastSignature: string | null; resumeBefore: string | null } {
  if (input.exhausted) {
    return { lastSignature: input.newest ?? input.previousCursor, resumeBefore: null };
  }
  return { lastSignature: input.previousCursor, resumeBefore: input.oldest };
}
