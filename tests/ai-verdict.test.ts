import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { interpretFomoHttp, isSubstantive, parseThesisFeed, readHolderTheses, resetFomoForTests, setFomoGapForTests } from "@/lib/ai/fomo";
import { modelCallTimeoutMs, readUsage, requestVerdict } from "@/lib/ai/gateway";
import { runShadowVerdictBatch } from "@/lib/ai/run";
import type { AiVerdictBody, HolderThesis } from "@/lib/ai/types";
import {
  DEFAULT_DAILY_CAP,
  MODEL_CALL_MIN_MS,
  MODEL_CALL_TIMEOUT_MS,
  VERDICT_SYSTEM_PROMPT,
  buildVerdictPrompt,
  decideAiVerdict,
  gainSinceFirstAlert,
  hashInputs,
  istDayStart,
  loadVerdictConfig,
  modelChain,
  movedAtLeast,
  parseVerdictText,
  summarizeShadowBuckets,
  thesisFingerprint,
  thesisSignal,
} from "@/lib/ai/verdict-logic";
import { applyMigrations } from "@/lib/db/migrate";
import { getToken } from "@/lib/db/repo";
import { countCappedVerdictsSince, latestAttempt } from "@/lib/db/verdicts";
import * as schema from "@/lib/db/schema";

const goodBody: AiVerdictBody = {
  verdict: "strong",
  conviction: 72,
  bullPoints: ["The writeup names a product people already use", "Liquidity is described instead of promised"],
  redFlags: [],
  narrative: "A tool narrative with one concrete user",
  invalidation: "A later post that the dev wallet sold or the pool was pulled",
  holderSummary: "The author is still holding a small position",
  reasoning: "The thesis gives a mechanism rather than a slogan, and nothing in the snapshot contradicts it.",
};

const thesis: HolderThesis = {
  who: "holder",
  text: "The team ships a tool people already use, so this is not only a ticker.",
  sizeUsd: 400,
  unrealizedUsd: 50,
  realizedUsd: 0,
  pnlPct: 12,
  closed: false,
  likes: 2,
  replies: 1,
  at: "2026-11-10T08:00:00.000Z",
};

const configured = {
  gatewayUrl: "https://gateway.example/v1",
  apiKey: "test-key",
  model: "google/gemini-2.5-flash",
  dailyCap: 60,
};

afterEach(() => {
  resetFomoForTests();
});

describe("verdict JSON", () => {
  it("accepts snake_case, fenced JSON, and rounded conviction", () => {
    const fenced = "```json\n" + JSON.stringify({
      verdict: " OK ",
      conviction: "71.6",
      bull_points: ["one concrete reason", "a second reason", "extra", "dropped"],
      red_flags: ["dev sold"],
      narrative: "one line\nonly",
      invalidation: "price loses the pool",
      holder_summary: "authors closed",
      reasoning: "short paragraph",
    }) + "\n```";
    const parsed = parseVerdictText(fenced);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verdict).toBe("ok");
    expect(parsed.value.conviction).toBe(72);
    expect(parsed.value.bullPoints).toEqual(["one concrete reason", "a second reason", "extra"]);
    expect(parsed.value.redFlags).toEqual(["dev sold"]);
    expect(parsed.value.narrative).toBe("one line only");
  });

  it("rejects a single bull point and a verdict outside the enum", () => {
    expect(parseVerdictText(JSON.stringify({ ...goodBody, bullPoints: ["only one"] })).ok).toBe(false);
    expect(parseVerdictText(JSON.stringify({ ...goodBody, verdict: "moon" })).ok).toBe(false);
    expect(parseVerdictText("not json").ok).toBe(false);
  });
});

describe("verdict triggers", () => {
  const base = {
    status: "candidate",
    nowMs: 1_000_000,
    lastAttemptAtMs: null as number | null,
    lastJudgement: null as { priceUsd: number | null; mcapUsd: number | null; stage: string | null } | null,
    priceUsd: 1,
    mcapUsd: 1000,
    stage: "t0",
    theses: "unknown" as const,
    usedToday: 0,
    dailyCap: 2,
  };

  it("runs the first judgement, then only a material change after the gap", () => {
    expect(decideAiVerdict(base)).toEqual({ run: true, reason: "first" });
    expect(decideAiVerdict({ ...base, status: "watching" })).toEqual({ run: false, reason: "not_candidate" });
    const judged = {
      ...base,
      lastAttemptAtMs: base.nowMs - 10 * 60_000,
      lastJudgement: { priceUsd: 1, mcapUsd: 1000, stage: "t0" },
    };
    expect(decideAiVerdict({ ...judged, priceUsd: 1.4 })).toEqual({ run: false, reason: "gap" });
    expect(decideAiVerdict({ ...judged, lastAttemptAtMs: base.nowMs - 30 * 60_000, priceUsd: 1.4 })).toEqual({
      run: true,
      reason: "price",
    });
    expect(decideAiVerdict({ ...judged, lastAttemptAtMs: base.nowMs - 30 * 60_000, priceUsd: 1.29 })).toEqual({
      run: false,
      reason: "unchanged",
    });
    expect(decideAiVerdict({ ...judged, lastAttemptAtMs: base.nowMs - 30 * 60_000, stage: "t15" })).toEqual({
      run: true,
      reason: "stage",
    });
    expect(decideAiVerdict({
      ...judged,
      lastAttemptAtMs: base.nowMs - 30 * 60_000,
      theses: "new",
    })).toEqual({ run: true, reason: "theses" });
  });

  it("treats a 30% move as material and blocks the run at the cap", () => {
    expect(movedAtLeast(100, 130)).toBe(true);
    expect(movedAtLeast(100, 70)).toBe(true);
    expect(movedAtLeast(100, 129.99)).toBe(false);
    expect(decideAiVerdict({ ...base, usedToday: 2 })).toEqual({ run: false, reason: "cap" });
    expect(decideAiVerdict({
      ...base,
      usedToday: 2,
      lastAttemptAtMs: base.nowMs - 31 * 60_000,
      lastJudgement: { priceUsd: 1, mcapUsd: 1000, stage: "t0" },
      priceUsd: 2,
    })).toEqual({ run: false, reason: "cap" });
  });

  it("does not treat the same thesis set as new", () => {
    expect(thesisSignal(thesisFingerprint([thesis]), [thesis])).toBe("same");
    expect(thesisSignal(thesisFingerprint([thesis]), [{ ...thesis, text: "A different mechanism." }])).toBe("new");
    expect(thesisFingerprint([thesis, { ...thesis, who: "b" }])).toBe(thesisFingerprint([{ ...thesis, who: "b" }, thesis]));
  });
});

describe("verdict prompt and stats", () => {
  it("keeps the judging rules and does not cite a thesis count", () => {
    expect(VERDICT_SYSTEM_PROMPT.toLowerCase()).toContain("quality of reasoning");
    expect(VERDICT_SYSTEM_PROMPT.toLowerCase()).toContain("soft signal");
    expect(VERDICT_SYSTEM_PROMPT.toLowerCase()).toContain("not a veto");
    expect(VERDICT_SYSTEM_PROMPT.toLowerCase()).toContain("how many wallets bought");
    expect(VERDICT_SYSTEM_PROMPT.toLowerCase()).toContain("dev sold");
    expect(VERDICT_SYSTEM_PROMPT.toLowerCase()).toContain("pure shill");
    expect(VERDICT_SYSTEM_PROMPT.toLowerCase()).toContain("exited while still posting bullish");
    const prompt = buildVerdictPrompt(
      {
        mint: "Mint",
        symbol: "TOOL",
        name: "Tool",
        stage: "t5",
        priceUsd: 1.2,
        mcapUsd: 1200,
        liqUsd: 4000,
        volM5: 100,
        volH1: 800,
        buysM5: 3,
        sellsM5: 1,
        buysH1: 9,
        sellsH1: 4,
        age: "2h",
        firstAlertAt: "2026-11-10T06:00:00.000Z",
        firstAlertPriceUsd: 1,
        firstAlertMcapUsd: 1000,
        gainPct: 20,
        gainBasis: "price",
        athGainPct: 40,
        rugcheckNormalised: 12,
        topHolderPct: 8,
        mintRevoked: true,
        freezeRevoked: true,
        venue: "pump.fun",
      },
      [thesis],
    );
    expect(prompt.user).toContain("@holder");
    expect(prompt.user).toContain("not a strength signal");
    expect(prompt.user).not.toMatch(/\d+ theses/);
  });

  it("compares buckets on gain since first alert", () => {
    expect(gainSinceFirstAlert({
      lastPriceUsd: 1.5,
      firstAlertPriceUsd: 1,
      lastMcapUsd: null,
      firstAlertMcapUsd: null,
      athPriceUsd: 2,
      athGainPct: null,
    })).toEqual({ gainPct: 50, athGainPct: 100 });
    const buckets = summarizeShadowBuckets([
      { verdict: "strong", gainPct: 10, athGainPct: 40 },
      { verdict: "strong", gainPct: 30, athGainPct: 80 },
      { verdict: "strong", gainPct: null, athGainPct: null },
      { verdict: "avoid", gainPct: -20, athGainPct: 5 },
      { verdict: "unavailable", gainPct: 100, athGainPct: 100 },
    ]);
    expect(buckets.find((bucket) => bucket.verdict === "strong")).toMatchObject({
      n: 3,
      withGain: 2,
      avgGainPct: 20,
      medianGainPct: 20,
      avgAthGainPct: 60,
    });
    expect(buckets.find((bucket) => bucket.verdict === "ok")).toMatchObject({ n: 0, avgGainPct: null });
    expect(buckets.find((bucket) => bucket.verdict === "avoid")?.n).toBe(1);
  });

  it("uses the IST day and a cheap flash default", () => {
    expect(istDayStart(new Date("2026-11-10T18:00:00.000Z")).toISOString()).toBe("2026-11-09T18:30:00.000Z");
    expect(istDayStart(new Date("2026-11-10T20:00:00.000Z")).toISOString()).toBe("2026-11-10T18:30:00.000Z");
    expect(loadVerdictConfig({}).model).toBe("google/gemini-2.5-flash");
    expect(loadVerdictConfig({}).dailyCap).toBe(DEFAULT_DAILY_CAP);
    expect(loadVerdictConfig({ AI_VERDICT_DAILY_CAP: "0" }).dailyCap).toBe(0);
    expect(loadVerdictConfig({ AI_VERDICT_DAILY_CAP: "nope" }).dailyCap).toBe(60);
    expect(loadVerdictConfig({ AI_VERDICT_MODEL: "google/gemini-3.6-flash" }).model).toBe("google/gemini-3.6-flash");
    expect(modelChain("google/gemini-2.5-flash")).toEqual(["google/gemini-2.5-flash", "google/gemini-3.6-flash"]);
    expect(hashInputs({ b: 1, a: 2 })).toBe(hashInputs({ a: 2, b: 1 }));
  });
});

describe("fomo thesis read", () => {
  it("keeps substantive posts and the author's position", () => {
    expect(isSubstantive("gm")).toBe(false);
    expect(isSubstantive("join: https://discord.gg/abc")).toBe(false);
    const parsed = parseThesisFeed({
      responseObject: {
        items: [
          {
            createdAt: "2026-11-10T08:00:00.000Z",
            userHandle: "holder",
            numReplies: 1,
            comment: { comment: "A real reason to hold through the week.", numLikes: 3 },
            authorTrade: { usdValue: 250, unrealizedPnlUsd: 40, percentageUnrealizedPnl: 16, closedAt: null },
          },
          {
            createdAt: "2026-11-10T07:00:00.000Z",
            userHandle: "out",
            comment: { comment: "Took profit, still think the tool ships.", numLikes: 0 },
            authorTrade: { usdValue: 0, realizedPnlUsd: 80, percentageRealizedPnl: 40, closedAt: "2026-11-10T07:30:00.000Z" },
          },
          { comment: { comment: "🔥" } },
        ],
      },
    }, "Mint");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.who).toBe("holder");
    expect(parsed[0]?.closed).toBe(false);
    expect(parsed[1]?.closed).toBe(true);
    expect(parsed[1]?.pnlPct).toBe(40);
  });

  it("classifies 401, 429, and HTML without throwing", async () => {
    expect(interpretFomoHttp(401, "{\"error\":\"no\"}").ok).toBe(false);
    expect(interpretFomoHttp(200, "<html>challenge</html>")).toEqual({ ok: false, reason: "fomo_html" });
    setFomoGapForTests(0);
    let calls = 0;
    const read = await readHolderTheses("Mint111", {
      token: "session",
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("slow", { status: 429 });
        return new Response(JSON.stringify({ responseObject: { items: [] } }), { status: 200 });
      },
    });
    expect(read).toEqual({ ok: true, theses: [] });
    const denied = await readHolderTheses("Mint222", {
      token: "session",
      retryDelayMs: 0,
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    expect(denied).toEqual({ ok: false, reason: "fomo_401" });
    const html = await readHolderTheses("Mint333", {
      token: "session",
      retryDelayMs: 0,
      fetchImpl: async () => new Response("<html></html>", { status: 200 }),
    });
    expect(html).toEqual({ ok: false, reason: "fomo_html" });
    let called = false;
    const missing = await readHolderTheses("Mint444", {
      env: { NODE_ENV: "test" },
      fetchImpl: async () => {
        called = true;
        return new Response("no");
      },
    });
    expect(missing).toEqual({ ok: false, reason: "fomo_auth" });
    expect(called).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("model gateway", () => {
  it("retries once on invalid JSON and records usage", async () => {
    let calls = 0;
    const result = await requestVerdict(configured, [{ role: "user", content: "judge" }], {
      timeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ choices: [{ message: { content: "nope" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify(goodBody) } }],
          usage: { prompt_tokens: 9, completion_tokens: 8, cost: 0.0001 },
        });
      },
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.verdict).toBe("strong");
    expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 8, costUsd: 0.0001 });
  });

  it("falls back when the model is unsupported and fails soft on HTTP errors", async () => {
    const models: string[] = [];
    const fallback = await requestVerdict(configured, [{ role: "user", content: "judge" }], {
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        models.push(body.model);
        if (body.model === "google/gemini-2.5-flash") return jsonResponse({ error: { message: "model_not_found" } }, 404);
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(goodBody) } }] });
      },
    });
    expect(models).toEqual(["google/gemini-2.5-flash", "google/gemini-3.6-flash"]);
    expect(fallback.ok && fallback.model).toBe("google/gemini-3.6-flash");

    let called = false;
    const missing = await requestVerdict({ ...configured, apiKey: null }, [{ role: "user", content: "judge" }], {
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    });
    expect(missing).toEqual({ ok: false, reason: "missing_env", model: null });
    expect(called).toBe(false);

    const failed = await requestVerdict(configured, [{ role: "user", content: "judge" }], {
      fetchImpl: async () => jsonResponse({ error: "nope" }, 500),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.reason).toBe("model_error");
    expect(readUsage({ usage: { input_tokens: 3, output_tokens: 4, total_cost: 0.2 } })).toEqual({
      promptTokens: 3,
      completionTokens: 4,
      costUsd: 0.2,
    });
  });

  it("bounds each model attempt by a 15s cap and the remaining deadline", async () => {
    expect(MODEL_CALL_TIMEOUT_MS).toBe(15_000);
    const now = 1_000_000;
    expect(modelCallTimeoutMs(20_000)).toBe(15_000);
    expect(modelCallTimeoutMs(10_000, now + 4_000, now)).toBe(4_000);
    expect(modelCallTimeoutMs(15_000, now + MODEL_CALL_MIN_MS - 1, now)).toBeNull();
    expect(modelCallTimeoutMs(15_000, now + MODEL_CALL_MIN_MS, now)).toBe(MODEL_CALL_MIN_MS);

    let calls = 0;
    const missed = await requestVerdict(configured, [{ role: "user", content: "judge" }], {
      deadlineMs: Date.now() - 1,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(goodBody) } }] });
      },
    });
    expect(calls).toBe(0);
    expect(missed).toEqual({ ok: false, reason: "model_error", model: "google/gemini-2.5-flash" });

    const started = Date.now();
    const skippedRetry = await requestVerdict(configured, [{ role: "user", content: "judge" }], {
      deadlineMs: started + 1_800,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return jsonResponse({ choices: [{ message: { content: "nope" } }] });
        }
        throw new Error("retry should not run after the deadline is too close");
      },
    });
    expect(calls).toBe(1);
    expect(skippedRetry).toEqual({ ok: false, reason: "invalid_json", model: "google/gemini-2.5-flash" });
  });
});

async function database() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await applyMigrations(db);
  return db;
}

async function seedCandidate(db: Awaited<ReturnType<typeof database>>, mint: string, price = 1) {
  await db.execute(sql`INSERT INTO tokens (
    mint, status, score, confidence, weak_rechecks, score_pending,
    last_price_usd, last_mcap_usd, first_alert_at, first_alert_price_usd, first_alert_mcap_usd, ath_price_usd
  ) VALUES (
    ${mint}, 'candidate', 61, 44, 1, 70,
    ${price}, ${price * 1000}, '2026-11-10T06:00:00Z', 1, 1000, ${price}
  )`);
}

describe("shadow verdict batch", () => {
  const at = new Date("2026-11-10T12:00:00.000Z");

  async function unchangedToken(db: Awaited<ReturnType<typeof database>>, mint: string) {
    const token = await getToken(db, mint);
    expect(token?.score).toBe(61);
    expect(token?.confidence).toBe(44);
    expect(token?.status).toBe("candidate");
    expect(token?.weakRechecks).toBe(1);
    expect(token?.scorePending).toBe(70);
  }

  it("stores a verdict without touching score, confidence, stage, or archive", async () => {
    const db = await database();
    const mint = "MintShadow11111111111111111111111111111111";
    await seedCandidate(db, mint);
    let modelCalls = 0;
    const batch = await runShadowVerdictBatch(db, {
      now: () => at,
      deadlineMs: Date.now() + 10_000,
      config: configured,
      readTheses: async () => ({ ok: true, theses: [thesis] }),
      requestVerdict: async () => {
        modelCalls += 1;
        return {
          ok: true,
          verdict: goodBody,
          model: "google/gemini-2.5-flash",
          usage: { promptTokens: 11, completionTokens: 22, costUsd: 0.0002 },
        };
      },
    });
    expect(batch.stored).toBe(1);
    expect(modelCalls).toBe(1);
    await unchangedToken(db, mint);
    const row = await latestAttempt(db, mint);
    expect(row?.verdict).toBe("strong");
    expect(row?.conviction).toBe(72);
    expect(row?.countsTowardCap).toBe(true);
    expect(row?.theses[0]?.who).toBe("holder");
    expect(row?.promptTokens).toBe(11);
    expect(row?.costUsd).toBeCloseTo(0.0002);
  });

  it("marks FOMO and model failures unavailable and keeps going", async () => {
    const db = await database();
    const denied = "MintDenied11111111111111111111111111111111";
    const broken = "MintBroken1111111111111111111111111111111";
    await seedCandidate(db, denied);
    await seedCandidate(db, broken, 2);
    const batch = await runShadowVerdictBatch(db, {
      now: () => at,
      limit: 2,
      deadlineMs: Date.now() + 10_000,
      config: configured,
      readTheses: async (mint) => (mint === denied ? { ok: false, reason: "fomo_401" } : { ok: true, theses: [thesis] }),
      requestVerdict: async () => ({ ok: false, reason: "model_error", model: "google/gemini-2.5-flash" }),
    });
    expect(batch.stored).toBe(2);
    expect(batch.stopped).toBeNull();
    const first = await latestAttempt(db, denied);
    const second = await latestAttempt(db, broken);
    expect(first?.verdict).toBe("unavailable");
    expect(first?.unavailableReason).toBe("fomo_401");
    expect(first?.countsTowardCap).toBe(false);
    expect(second?.verdict).toBe("unavailable");
    expect(second?.unavailableReason).toBe("model_error");
    expect(second?.countsTowardCap).toBe(true);
    await unchangedToken(db, denied);
    await unchangedToken(db, broken);

    const shaky = "MintShaky11111111111111111111111111111111";
    await seedCandidate(db, shaky, 3);
    const survived = await runShadowVerdictBatch(db, {
      now: () => at,
      limit: 1,
      deadlineMs: Date.now() + 10_000,
      config: configured,
      readTheses: async () => {
        throw new Error("boom");
      },
      requestVerdict: async () => {
        throw new Error("should not call");
      },
    });
    expect(survived.stored).toBe(0);
    expect(survived.skipped).toBeGreaterThan(0);
    await unchangedToken(db, shaky);
  });

  it("does not call the model when the gateway env is missing", async () => {
    const db = await database();
    const mint = "MintMissing1111111111111111111111111111111";
    await seedCandidate(db, mint);
    let called = false;
    const batch = await runShadowVerdictBatch(db, {
      now: () => at,
      deadlineMs: Date.now() + 10_000,
      config: { ...configured, gatewayUrl: null, apiKey: null },
      readTheses: async () => ({ ok: true, theses: [thesis] }),
      requestVerdict: async () => {
        called = true;
        return { ok: false, reason: "missing_env", model: null };
      },
    });
    expect(called).toBe(false);
    expect(batch.stopped).toBe("missing_env");
    const row = await latestAttempt(db, mint);
    expect(row?.unavailableReason).toBe("missing_env");
    expect(row?.countsTowardCap).toBe(false);
  });

  it("respects the daily cap, the 30 minute gap, and material changes", async () => {
    const db = await database();
    const mint = "MintCap11111111111111111111111111111111111";
    const other = "MintOther11111111111111111111111111111111";
    await seedCandidate(db, mint, 1);
    await seedCandidate(db, other, 1);
    await db.execute(sql`INSERT INTO ai_verdicts (
      mint, created_at, verdict, inputs_hash, trigger, counts_toward_cap, model
    ) VALUES (
      ${other}, '2026-11-10T10:00:00Z', 'ok', 'hash', 'first', true, 'google/gemini-2.5-flash'
    )`);
    const capped = await runShadowVerdictBatch(db, {
      now: () => at,
      deadlineMs: Date.now() + 10_000,
      config: { ...configured, dailyCap: 1 },
      readTheses: async () => ({ ok: true, theses: [thesis] }),
      requestVerdict: async () => {
        throw new Error("should not call");
      },
    });
    expect(capped).toMatchObject({ stored: 0, stopped: "cap" });
    expect(await countCappedVerdictsSince(db, istDayStart(at))).toBe(1);
    await db.execute(sql`DELETE FROM ai_verdicts WHERE mint = ${other}`);
    await db.execute(sql`UPDATE tokens SET status = 'seen' WHERE mint = ${other}`);

    let calls = 0;
    const openConfig = { ...configured, dailyCap: 60 };
    const judge = () =>
      ({
        ok: true as const,
        verdict: { ...goodBody, verdict: "ok" as const },
        model: "google/gemini-2.5-flash",
        usage: { promptTokens: 1, completionTokens: 1, costUsd: null },
      });
    const first = await runShadowVerdictBatch(db, {
      now: () => at,
      deadlineMs: Date.now() + 10_000,
      config: openConfig,
      readTheses: async () => ({ ok: true, theses: [thesis] }),
      requestVerdict: async () => {
        calls += 1;
        return judge();
      },
    });
    expect(first.stored).toBe(1);
    const soon = await runShadowVerdictBatch(db, {
      now: () => new Date(at.getTime() + 10 * 60_000),
      deadlineMs: Date.now() + 10_000,
      config: openConfig,
      readTheses: async () => ({ ok: true, theses: [thesis] }),
      requestVerdict: async () => {
        calls += 1;
        return judge();
      },
    });
    expect(soon.stored).toBe(0);
    expect(calls).toBe(1);

    await db.execute(sql`UPDATE tokens SET last_price_usd = 1.4 WHERE mint = ${mint}`);
    const moved = await runShadowVerdictBatch(db, {
      now: () => new Date(at.getTime() + 31 * 60_000),
      deadlineMs: Date.now() + 10_000,
      config: openConfig,
      readTheses: async () => ({ ok: true, theses: [thesis] }),
      requestVerdict: async () => {
        calls += 1;
        return judge();
      },
    });
    expect(moved.stored).toBe(1);
    expect((await latestAttempt(db, mint))?.trigger).toBe("price");

    await db.execute(sql`INSERT INTO token_checks (mint, stage, passed) VALUES (${mint}, 't15', true)`);
    const staged = await runShadowVerdictBatch(db, {
      now: () => new Date(at.getTime() + 70 * 60_000),
      deadlineMs: Date.now() + 10_000,
      config: openConfig,
      readTheses: async () => ({ ok: true, theses: [thesis] }),
      requestVerdict: async () => {
        calls += 1;
        return judge();
      },
    });
    expect(staged.stored).toBe(1);
    expect((await latestAttempt(db, mint))?.trigger).toBe("stage");
    await unchangedToken(db, mint);
  });

  it("skips the model when the recheck deadline is already too close", async () => {
    const db = await database();
    const mint = "MintDeadline11111111111111111111111111111";
    await seedCandidate(db, mint);
    let theses = 0;
    let models = 0;
    const batch = await runShadowVerdictBatch(db, {
      now: () => at,
      deadlineMs: Date.now() - 1,
      config: configured,
      readTheses: async () => {
        theses += 1;
        return { ok: true, theses: [thesis] };
      },
      requestVerdict: async () => {
        models += 1;
        throw new Error("should not call");
      },
    });
    expect(batch.stored).toBe(0);
    expect(theses).toBe(0);
    expect(models).toBe(0);
    expect(await latestAttempt(db, mint)).toBeNull();
    await unchangedToken(db, mint);
  });
});
