import type { FomoRead } from "@/lib/ai/fomo";
import { readHolderTheses } from "@/lib/ai/fomo";
import { requestVerdict as callVerdictModel } from "@/lib/ai/gateway";
import type { HolderThesis } from "@/lib/ai/types";
import {
  MODEL_CALL_MIN_MS,
  MODEL_CALL_TIMEOUT_MS,
  VERDICT_BATCH_LIMIT,
  VERDICT_GAP_MS,
  VERDICT_SCAN_LIMIT,
  buildVerdictPrompt,
  decideAiVerdict,
  gainSinceFirstAlert,
  gatewayConfigured,
  hashInputs,
  istDayStart,
  loadVerdictConfig,
  marketAge,
  newestThesisAt,
  thesisFingerprint,
  thesisSignal,
  type VerdictConfig,
} from "@/lib/ai/verdict-logic";
import type { AppDb } from "@/lib/db/index";
import { getToken, type TokenRecord } from "@/lib/db/repo";
import {
  countCappedVerdictsSince,
  dueCandidateMints,
  insertAiVerdict,
  latestAttempt,
  latestCheckStage,
  latestJudgement,
  type AiVerdictInsert,
} from "@/lib/db/verdicts";
import { resolveGain } from "@/lib/logic/gains";

export type VerdictBatchResult = {
  stored: number;
  skipped: number;
  attempted: number;
  stopped: string | null;
};

type RunnerDeps = {
  now: () => Date;
  limit: number;
  scan: number;
  deadlineMs: number;
  config: VerdictConfig;
  readTheses: (mint: string) => Promise<FomoRead>;
  requestVerdict: typeof callVerdictModel;
};

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "error";
  return message.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/[A-Za-z0-9_-]{30,}/g, "[redacted]").slice(0, 160);
}

function baseInsert(
  token: TokenRecord,
  now: Date,
  stage: string | null,
  trigger: string,
  theses: HolderThesis[],
  fingerprint: string | null,
): AiVerdictInsert {
  return {
    mint: token.mint,
    createdAt: now,
    verdict: "unavailable",
    conviction: null,
    bullPoints: [],
    redFlags: [],
    narrative: null,
    invalidation: null,
    holderSummary: null,
    reasoning: null,
    unavailableReason: null,
    model: null,
    inputsHash: hashInputs({
      mint: token.mint,
      stage,
      priceUsd: token.lastPriceUsd,
      mcapUsd: token.lastMcapUsd,
      fingerprint,
    }),
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    stage,
    priceUsd: token.lastPriceUsd,
    mcapUsd: token.lastMcapUsd,
    thesisFingerprint: fingerprint,
    thesisNewestAt: (() => {
      const newest = newestThesisAt(theses);
      return newest ? new Date(newest) : null;
    })(),
    theses,
    trigger,
    countsTowardCap: false,
  };
}

/**
 * Shadow mode. Writes ai_verdicts only. Score, confidence, stage, archive, and hysteresis stay untouched.
 */
export async function runShadowVerdictBatch(
  db: AppDb,
  options: Partial<RunnerDeps> = {},
): Promise<VerdictBatchResult> {
  const nowFn = options.now ?? (() => new Date());
  const limit = options.limit ?? VERDICT_BATCH_LIMIT;
  const scan = options.scan ?? VERDICT_SCAN_LIMIT;
  const deadlineMs = options.deadlineMs ?? Date.now() + 18_000;
  const config = options.config ?? loadVerdictConfig();
  const readTheses = options.readTheses ?? ((mint: string) => readHolderTheses(mint, { deadlineMs }));
  const requestVerdict = options.requestVerdict ?? callVerdictModel;
  const result: VerdictBatchResult = { stored: 0, skipped: 0, attempted: 0, stopped: null };

  try {
    const now = nowFn();
    const usedToday = await countCappedVerdictsSince(db, istDayStart(now));
    if (usedToday >= config.dailyCap) return { ...result, stopped: "cap" };
    const due = await dueCandidateMints(db, new Date(now.getTime() - VERDICT_GAP_MS), scan);
    let used = usedToday;
    for (const mint of due) {
      if (result.stored >= limit || Date.now() > deadlineMs) break;
      try {
        const wrote = await judgeOne({
          db,
          mint,
          now: nowFn(),
          config,
          used,
          readTheses,
          requestVerdict,
          deadlineMs,
          onAttempt: () => {
            result.attempted += 1;
          },
        });
        if (wrote.action === "skip") {
          result.skipped += 1;
          if (wrote.reason === "cap") {
            result.stopped = "cap";
            break;
          }
          continue;
        }
        result.stored += 1;
        if (wrote.countsTowardCap) used += 1;
        if (wrote.stop) {
          result.stopped = wrote.stop;
          break;
        }
      } catch (error) {
        result.skipped += 1;
        console.warn(`[keel] ai verdict skipped ${safeError(error)}`);
      }
    }
    return result;
  } catch (error) {
    console.warn(`[keel] ai verdict batch failed ${safeError(error)}`);
    return { ...result, stopped: "batch_error" };
  }
}

type JudgeOutcome =
  | { action: "skip"; reason: string }
  | { action: "stored"; countsTowardCap: boolean; stop: string | null };

async function judgeOne(input: {
  db: AppDb;
  mint: string;
  now: Date;
  config: VerdictConfig;
  used: number;
  readTheses: (mint: string) => Promise<FomoRead>;
  requestVerdict: typeof callVerdictModel;
  deadlineMs: number;
  onAttempt: () => void;
}): Promise<JudgeOutcome> {
  const token = await getToken(input.db, input.mint);
  if (!token || token.status !== "candidate") return { action: "skip", reason: "not_candidate" };
  const [attempt, judgement, stage] = await Promise.all([
    latestAttempt(input.db, token.mint),
    latestJudgement(input.db, token.mint),
    latestCheckStage(input.db, token.mint),
  ]);
  let decision = decideAiVerdict({
    status: token.status,
    nowMs: input.now.getTime(),
    lastAttemptAtMs: attempt?.createdAt.getTime() ?? null,
    lastJudgement: judgement
      ? { priceUsd: judgement.priceUsd, mcapUsd: judgement.mcapUsd, stage: judgement.stage }
      : null,
    priceUsd: token.lastPriceUsd,
    mcapUsd: token.lastMcapUsd,
    stage,
    theses: "unknown",
    usedToday: input.used,
    dailyCap: input.config.dailyCap,
  });
  if (!decision.run && decision.reason !== "unchanged") return { action: "skip", reason: decision.reason };
  if (!gatewayConfigured(input.config)) {
    if (!decision.run) return { action: "skip", reason: "unchanged" };
    await insertAiVerdict(
      input.db,
      unavailable(token, input.now, stage, decision.reason, [], null, "missing_env"),
    );
    return { action: "stored", countsTowardCap: false, stop: "missing_env" };
  }

  let theses: HolderThesis[] | null = null;
  let fomo: FomoRead | null = null;
  const loadTheses = async (): Promise<FomoRead> => {
    if (fomo) return fomo;
    fomo = await input.readTheses(token.mint);
    theses = fomo.ok ? fomo.theses : [];
    return fomo;
  };

  if (!decision.run && judgement) {
    const read = await loadTheses();
    if (!read.ok) return { action: "skip", reason: "unchanged" };
    const signal = thesisSignal(judgement.thesisFingerprint, read.theses);
    decision = decideAiVerdict({
      status: token.status,
      nowMs: input.now.getTime(),
      lastAttemptAtMs: attempt?.createdAt.getTime() ?? null,
      lastJudgement: { priceUsd: judgement.priceUsd, mcapUsd: judgement.mcapUsd, stage: judgement.stage },
      priceUsd: token.lastPriceUsd,
      mcapUsd: token.lastMcapUsd,
      stage,
      theses: signal,
      usedToday: input.used,
      dailyCap: input.config.dailyCap,
    });
    if (!decision.run) return { action: "skip", reason: decision.reason };
  }
  if (!decision.run) return { action: "skip", reason: "unchanged" };
  if (input.deadlineMs - Date.now() < MODEL_CALL_MIN_MS) return { action: "skip", reason: "deadline" };

  const read = await loadTheses();
  const held = theses ?? [];
  const fingerprint = read.ok ? thesisFingerprint(held) : null;
  if (!read.ok) {
    await insertAiVerdict(
      input.db,
      unavailable(token, input.now, stage, decision.reason, [], fingerprint, read.reason),
    );
    return { action: "stored", countsTowardCap: false, stop: null };
  }

  const since = gainSinceFirstAlert(token);
  const gain = resolveGain({
    lastPrice: token.lastPriceUsd,
    entryPrice: token.firstAlertPriceUsd,
    lastMcap: token.lastMcapUsd,
    entryMcap: token.firstAlertMcapUsd,
  });
  const prompt = buildVerdictPrompt(
    {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      stage,
      priceUsd: token.lastPriceUsd,
      mcapUsd: token.lastMcapUsd,
      liqUsd: token.lastLiqUsd,
      volM5: token.lastVolM5,
      volH1: token.lastVolH1,
      buysM5: token.lastBuysM5,
      sellsM5: token.lastSellsM5,
      buysH1: token.lastBuysH1,
      sellsH1: token.lastSellsH1,
      age: marketAge(token.firstAlertAt ?? token.firstSeenAt, input.now),
      firstAlertAt: token.firstAlertAt?.toISOString() ?? null,
      firstAlertPriceUsd: token.firstAlertPriceUsd,
      firstAlertMcapUsd: token.firstAlertMcapUsd,
      gainPct: since.gainPct,
      gainBasis: gain.basis,
      athGainPct: since.athGainPct,
      rugcheckNormalised: token.rugcheckNormalised,
      topHolderPct: token.topHolderPct,
      mintRevoked: token.mintRevoked,
      freezeRevoked: token.freezeRevoked,
      venue: token.venue,
    },
    held,
  );
  const remainingMs = input.deadlineMs - Date.now();
  if (remainingMs < MODEL_CALL_MIN_MS) return { action: "skip", reason: "deadline" };
  input.onAttempt();
  const call = await input.requestVerdict(
    input.config,
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    { timeoutMs: Math.min(MODEL_CALL_TIMEOUT_MS, remainingMs), deadlineMs: input.deadlineMs },
  );
  const row = baseInsert(token, input.now, stage, decision.reason, held, fingerprint);
  if (!call.ok) {
    row.unavailableReason = call.reason;
    row.model = call.model;
    row.countsTowardCap = call.reason !== "missing_env";
    await insertAiVerdict(input.db, row);
    console.warn(`[keel] ai verdict unavailable ${token.mint} ${call.reason}`);
    return {
      action: "stored",
      countsTowardCap: row.countsTowardCap,
      stop: call.reason === "model_unsupported" || call.reason === "missing_env" ? call.reason : null,
    };
  }
  row.verdict = call.verdict.verdict;
  row.conviction = call.verdict.conviction;
  row.bullPoints = call.verdict.bullPoints;
  row.redFlags = call.verdict.redFlags;
  row.narrative = call.verdict.narrative;
  row.invalidation = call.verdict.invalidation;
  row.holderSummary = call.verdict.holderSummary;
  row.reasoning = call.verdict.reasoning;
  row.model = call.model;
  row.promptTokens = call.usage.promptTokens;
  row.completionTokens = call.usage.completionTokens;
  row.costUsd = call.usage.costUsd;
  row.countsTowardCap = true;
  row.inputsHash = hashInputs({
    mint: token.mint,
    stage,
    priceUsd: token.lastPriceUsd,
    mcapUsd: token.lastMcapUsd,
    fingerprint,
    prompt: prompt.user,
  });
  await insertAiVerdict(input.db, row);
  console.info(`[keel] ai verdict ${token.mint} ${row.verdict} trigger=${decision.reason}`);
  return { action: "stored", countsTowardCap: true, stop: null };
}

function unavailable(
  token: TokenRecord,
  now: Date,
  stage: string | null,
  trigger: string,
  theses: HolderThesis[],
  fingerprint: string | null,
  reason: string,
): AiVerdictInsert {
  const row = baseInsert(token, now, stage, trigger, theses, fingerprint);
  row.unavailableReason = reason;
  return row;
}
