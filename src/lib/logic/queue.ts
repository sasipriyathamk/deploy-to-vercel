/** Lower runs first. Token discovery (enrich_t0) and rechecks run before the raw transaction backlog. */
export function jobPriority(type: string): number {
  switch (type) {
    case "enrich_t0":
      return 0;
    case "recheck_t5":
    case "recheck_t15":
      return 1;
    case "parse":
    case "parse_rpc":
      return 2;
    case "recheck_t60":
    case "hold_check":
      return 3;
    default:
      return 9;
  }
}

export const JOB_PRIORITY_SQL = `CASE type
  WHEN 'enrich_t0' THEN 0
  WHEN 'recheck_t5' THEN 1
  WHEN 'recheck_t15' THEN 1
  WHEN 'parse' THEN 2
  WHEN 'parse_rpc' THEN 2
  WHEN 'recheck_t60' THEN 3
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
