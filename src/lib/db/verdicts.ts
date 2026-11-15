import { alertsEnabled, captureObservation } from "@/lib/alerts/store";
import { desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "@/lib/db/index";
import { aiVerdicts } from "@/lib/db/schema";
import { asDate, asJson, asNumber, asRows } from "@/lib/db/rows";
import type { AiVerdictLabel, HolderThesis } from "@/lib/ai/types";

export type AiVerdictInsert = {
  mint: string;
  createdAt: Date;
  verdict: AiVerdictLabel;
  conviction: number | null;
  bullPoints: string[];
  redFlags: string[];
  narrative: string | null;
  invalidation: string | null;
  holderSummary: string | null;
  reasoning: string | null;
  unavailableReason: string | null;
  model: string | null;
  inputsHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  stage: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  thesisFingerprint: string | null;
  thesisNewestAt: Date | null;
  theses: HolderThesis[];
  trigger: string;
  countsTowardCap: boolean;
};

export type AiVerdictRecord = AiVerdictInsert & { id: number };

function asStringList(value: unknown): string[] {
  const parsed = asJson<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function asTheses(value: unknown): HolderThesis[] {
  const parsed = asJson<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.text !== "string" || typeof row.who !== "string") return [];
    return [
      {
        who: row.who,
        text: row.text,
        sizeUsd: asNumber(row.sizeUsd) ?? 0,
        unrealizedUsd: asNumber(row.unrealizedUsd) ?? 0,
        realizedUsd: asNumber(row.realizedUsd) ?? 0,
        pnlPct: asNumber(row.pnlPct) ?? 0,
        closed: row.closed === true,
        likes: asNumber(row.likes) ?? 0,
        replies: asNumber(row.replies) ?? 0,
        at: typeof row.at === "string" ? row.at : "",
      },
    ];
  });
}

export function mapAiVerdict(row: Record<string, unknown>): AiVerdictRecord {
  const verdict = String(row.verdict);
  const label: AiVerdictLabel =
    verdict === "strong" || verdict === "ok" || verdict === "avoid" || verdict === "unavailable" ? verdict : "unavailable";
  return {
    id: asNumber(row.id) ?? 0,
    mint: String(row.mint),
    createdAt: asDate(row.createdAt ?? row.created_at) ?? new Date(0),
    verdict: label,
    conviction: asNumber(row.conviction),
    bullPoints: asStringList(row.bullPoints ?? row.bull_points),
    redFlags: asStringList(row.redFlags ?? row.red_flags),
    narrative: (row.narrative as string | null) ?? null,
    invalidation: (row.invalidation as string | null) ?? null,
    holderSummary: ((row.holderSummary ?? row.holder_summary) as string | null) ?? null,
    reasoning: (row.reasoning as string | null) ?? null,
    unavailableReason: ((row.unavailableReason ?? row.unavailable_reason) as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    inputsHash: String(row.inputsHash ?? row.inputs_hash ?? ""),
    promptTokens: asNumber(row.promptTokens ?? row.prompt_tokens),
    completionTokens: asNumber(row.completionTokens ?? row.completion_tokens),
    costUsd: asNumber(row.costUsd ?? row.cost_usd),
    stage: (row.stage as string | null) ?? null,
    priceUsd: asNumber(row.priceUsd ?? row.price_usd),
    mcapUsd: asNumber(row.mcapUsd ?? row.mcap_usd),
    thesisFingerprint: ((row.thesisFingerprint ?? row.thesis_fingerprint) as string | null) ?? null,
    thesisNewestAt: asDate(row.thesisNewestAt ?? row.thesis_newest_at),
    theses: asTheses(row.theses),
    trigger: String(row.trigger ?? ""),
    countsTowardCap: row.countsTowardCap === true || row.counts_toward_cap === true,
  };
}

export async function insertAiVerdict(db: AppDb, row: AiVerdictInsert): Promise<number> {
  if (!alertsEnabled()) {
    const inserted = await db.insert(aiVerdicts).values(row).returning();
    return inserted[0]?.id ?? 0;
  }
  return db.transaction(async tx => {
    const [inserted] = await tx.insert(aiVerdicts).values(row).returning();
    await captureObservation(tx,row.mint,`ai:${inserted.id}`,row.createdAt,"ai_verdict",inserted,null);
    return inserted.id;
  });
}

export async function latestAttempt(db: AppDb, mint: string): Promise<AiVerdictRecord | null> {
  const rows = await db.select().from(aiVerdicts).where(eq(aiVerdicts.mint, mint)).orderBy(desc(aiVerdicts.createdAt)).limit(1);
  return rows[0] ? mapAiVerdict(rows[0] as unknown as Record<string, unknown>) : null;
}

export async function latestJudgement(db: AppDb, mint: string): Promise<AiVerdictRecord | null> {
  const rows = asRows<Record<string, unknown>>(
    await db.execute(sql`SELECT * FROM ai_verdicts
      WHERE mint = ${mint} AND verdict IN ('strong', 'ok', 'avoid')
      ORDER BY created_at DESC
      LIMIT 1`),
  );
  return rows[0] ? mapAiVerdict(rows[0]) : null;
}

export async function latestAiVerdicts(db: AppDb, mints: string[]): Promise<Map<string, AiVerdictRecord>> {
  const found = new Map<string, AiVerdictRecord>();
  if (mints.length === 0) return found;
  const rows = asRows<Record<string, unknown>>(
    await db.execute(sql`SELECT DISTINCT ON (mint) * FROM ai_verdicts
      WHERE mint IN (${sql.join(mints.map((mint) => sql`${mint}`), sql`, `)})
      ORDER BY mint, created_at DESC`),
  );
  for (const row of rows) found.set(String(row.mint), mapAiVerdict(row));
  return found;
}

export async function countCappedVerdictsSince(db: AppDb, since: Date): Promise<number> {
  const rows = asRows<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM ai_verdicts
      WHERE counts_toward_cap = true AND created_at >= ${since}`),
  );
  return Number(rows[0]?.n ?? 0);
}

export async function dueCandidateMints(db: AppDb, cutoff: Date, limit: number): Promise<string[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const rows = asRows<{ mint: string }>(
    await db.execute(sql`SELECT t.mint
      FROM tokens t
      LEFT JOIN LATERAL (
        SELECT created_at FROM ai_verdicts v WHERE v.mint = t.mint ORDER BY created_at DESC LIMIT 1
      ) latest ON true
      WHERE t.status = 'candidate'
        AND (latest.created_at IS NULL OR latest.created_at < ${cutoff})
      ORDER BY latest.created_at ASC NULLS FIRST, t.first_alert_at ASC NULLS LAST
      LIMIT ${safeLimit}`),
  );
  return rows.map((row) => row.mint);
}

export async function latestCheckStage(db: AppDb, mint: string): Promise<string | null> {
  const rows = asRows<{ stage: string }>(
    await db.execute(sql`SELECT stage FROM token_checks WHERE mint = ${mint} ORDER BY checked_at DESC LIMIT 1`),
  );
  return rows[0]?.stage ?? null;
}

export type ShadowGainRow = {
  verdict: string;
  lastPriceUsd: number | null;
  firstAlertPriceUsd: number | null;
  lastMcapUsd: number | null;
  firstAlertMcapUsd: number | null;
  athPriceUsd: number | null;
  athGainPct: number | null;
};

export async function shadowGainRows(db: AppDb): Promise<ShadowGainRow[]> {
  const rows = asRows<Record<string, unknown>>(
    await db.execute(sql`SELECT DISTINCT ON (v.mint)
        v.verdict,
        t.last_price_usd,
        t.first_alert_price_usd,
        t.last_mcap_usd,
        t.first_alert_mcap_usd,
        t.ath_price_usd,
        t.ath_gain_pct
      FROM ai_verdicts v
      JOIN tokens t ON t.mint = v.mint
      ORDER BY v.mint, v.created_at DESC`),
  );
  return rows.map((row) => ({
    verdict: String(row.verdict),
    lastPriceUsd: asNumber(row.last_price_usd),
    firstAlertPriceUsd: asNumber(row.first_alert_price_usd),
    lastMcapUsd: asNumber(row.last_mcap_usd),
    firstAlertMcapUsd: asNumber(row.first_alert_mcap_usd),
    athPriceUsd: asNumber(row.ath_price_usd),
    athGainPct: asNumber(row.ath_gain_pct),
  }));
}
