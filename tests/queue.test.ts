import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "@/lib/db/migrate";
import { countProviderCalls, enqueueJob, insertRawEvent, claimJobs, tryDrainLease, releaseDrainLease, requeueVersionedParseFailures, backfillOrphanMints } from "@/lib/db/repo";
import { asNumber, asRows } from "@/lib/db/rows";
import * as schema from "@/lib/db/schema";
import { exceedsProviderBudget } from "@/lib/budgets";
import { PARSED_TX_CONFIG } from "@/lib/budgets";
import { getTransaction, resetProviderGatesForTests } from "@/lib/market";
import { processQueue } from "@/lib/pipeline";

const wallet = "STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk";
const mint = "Mint111111111111111111111111111111111111111";

function sellTransaction() {
  return {
    slot: 9,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      preBalances: [1_000_000_000],
      postBalances: [1_400_000_000],
      preTokenBalances: [{ owner: wallet, mint, uiTokenAmount: { uiAmount: 5, decimals: 6 } }],
      postTokenBalances: [{ owner: wallet, mint, uiTokenAmount: { uiAmount: 1, decimals: 6 } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: ["sig"],
      message: { accountKeys: [{ pubkey: wallet }], instructions: [] },
    },
  };
}

async function openDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await applyMigrations(db);
  return { client, db };
}

async function seedParseJob(db: Awaited<ReturnType<typeof openDb>>["db"], signature: string) {
  await insertRawEvent(db, {
    signature,
    slot: 1,
    blockTime: new Date(),
    err: false,
    programs: [],
    source: null,
    wallet,
    mint: null,
    side: "unknown",
    solDelta: null,
    tokenDelta: null,
    decimals: null,
    venue: { venue: null, graduated: false },
    raw: { polled: true },
  });
  await enqueueJob(db, "parse_rpc", { signature }, new Date());
}

describe("poll backlog drain", () => {
  const previousKey = process.env.HELIUS_API_KEY;
  const previousFetch = globalThis.fetch;
  let fetches = 0;

  beforeEach(() => {
    process.env.HELIUS_API_KEY = previousKey || "test";
    resetProviderGatesForTests();
    fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: sellTransaction() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previousKey;
    resetProviderGatesForTests();
  });

  it("counts only the last minute and coerces a string count", async () => {
    const { client, db } = await openDb();
    try {
      await db.execute(sql`INSERT INTO provider_calls (provider, status, created_at)
        SELECT 'rpc', 200, now() - interval '3 hours' FROM generate_series(1, 200)`);
      await db.execute(sql`INSERT INTO provider_calls (provider, status, created_at)
        SELECT 'rpc', 200, now() FROM generate_series(1, 3)`);
      const raw = asRows<{ n: unknown }>(
        await db.execute(sql`SELECT count(*)::int AS n FROM provider_calls WHERE provider = 'rpc'`),
      )[0]?.n;
      expect(Number(raw)).toBe(203);
      expect(exceedsProviderBudget(raw, 120)).toBe(true);
      expect(exceedsProviderBudget(String(3), 120)).toBe(false);
      const recent = await countProviderCalls(db, "rpc", new Date(Date.now() - 60_000));
      expect(typeof recent).toBe("number");
      expect(recent).toBe(3);
      expect(exceedsProviderBudget(recent, 120)).toBe(false);
      await expect(getTransaction(db, "sig-recent")).resolves.toBeTruthy();
      expect(fetches).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("drains more than one claim batch instead of stopping at 6 jobs", async () => {
    const { client, db } = await openDb();
    try {
      for (let index = 0; index < 20; index += 1) await seedParseJob(db, `sig-${index}`);
      const started = Date.now();
      const result = await processQueue(db, 4, 20_000);
      const elapsed = Date.now() - started;
      expect(result.done).toBe(20);
      expect(result.failed).toBe(0);
      expect(result.claimed).toBe(20);
      expect(result.pending).toBe(0);
      expect(fetches).toBe(20);
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      expect(elapsed).toBeLessThan(20_000);
    } finally {
      await client.close();
    }
  });

  it("releases a full-budget batch without failing jobs or burning attempts", async () => {
    const { client, db } = await openDb();
    try {
      await db.execute(sql`INSERT INTO provider_calls (provider, status, created_at)
        SELECT 'rpc', 200, now() FROM generate_series(1, 120)`);
      for (let index = 0; index < 5; index += 1) await seedParseJob(db, `blocked-${index}`);
      const started = Date.now();
      const result = await processQueue(db, 16, 10_000);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(result.done).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.pending).toBe(5);
      expect(fetches).toBe(0);
      const rows = asRows<{ status: string; attempts: unknown; last_error: string | null; run_after: string | Date }>(
        await db.execute(sql`SELECT status, attempts, last_error, run_after FROM pipeline_jobs ORDER BY id`),
      );
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.status).toBe("pending");
        expect(asNumber(row.attempts)).toBe(0);
        expect(row.last_error).toBeNull();
        expect(new Date(row.run_after).getTime()).toBeGreaterThan(started);
      }
    } finally {
      await client.close();
    }
  });

  it("claims parse jobs before T0 and due rechecks", async () => {
    const { client, db } = await openDb();
    try {
      const earlier = new Date(Date.now() - 60_000);
      await enqueueJob(db, "recheck_t5", { mint: "mint-recheck" }, earlier);
      await enqueueJob(db, "enrich_t0", { mint: "mint-t0" }, earlier);
      await enqueueJob(db, "parse_rpc", { signature: "sig-new" }, new Date());
      const jobs = await claimJobs(db, 3);
      expect(jobs.map((job) => job.type)).toEqual(["parse_rpc", "enrich_t0", "recheck_t5"]);
    } finally {
      await client.close();
    }
  });

  it("does not hand the same drain lease to an overlapping run", async () => {
    const { client, db } = await openDb();
    try {
      await seedParseJob(db, "lease-a");
      await seedParseJob(db, "lease-b");
      expect(await tryDrainLease(db, "poll-a")).toBe(true);
      expect(await tryDrainLease(db, "gains-b")).toBe(false);
      const first = await claimJobs(db, 1);
      const second = await claimJobs(db, 1);
      expect(first[0]?.id).not.toBe(second[0]?.id);
      expect(await claimJobs(db, 1)).toEqual([]);
      await releaseDrainLease(db, "poll-a");
      expect(await tryDrainLease(db, "gains-b")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("stops claiming once the time budget is spent and leaves the rest pending", async () => {
    const { client, db } = await openDb();
    try {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: sellTransaction() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      for (let index = 0; index < 6; index += 1) await seedParseJob(db, `budget-${index}`);
      const result = await processQueue(db, 4, 3_000);
      expect(result.claimed).toBeLessThan(6);
      expect(result.failed).toBe(0);
      expect(result.pending).toBeGreaterThan(0);
      const running = asRows<{ n: unknown }>(
        await db.execute(sql`SELECT count(*)::int AS n FROM pipeline_jobs WHERE status = 'running'`),
      );
      expect(asNumber(running[0]?.n)).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("asks RPC for version 0 and survives a dead enhanced fallback", async () => {
    const { client, db } = await openDb();
    try {
      const seen: unknown[] = [];
      globalThis.fetch = async (input, init) => {
        const href = String(input);
        if (href.includes("/v0/transactions") || href.includes("pump.fun") || href.includes("gmgn.ai")) {
          throw new Error("fallback down api-key=secret");
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: unknown[] };
        seen.push(body.params?.[1]);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
      };
      await seedParseJob(db, "sig-missing");
      const result = await processQueue(db, 2, 8_000);
      expect(result.failed).toBe(1);
      expect(seen).toContainEqual(PARSED_TX_CONFIG);
      const row = asRows<{ status: string; last_error: string | null }>(
        await db.execute(sql`SELECT status, last_error FROM pipeline_jobs`),
      )[0];
      expect(row?.status).not.toBe("running");
      expect(row?.last_error ?? "").not.toContain("secret");
    } finally {
      await client.close();
    }
  });

  it("requeues versioned parse failures and creates token rows for orphan mints", async () => {
    const { client, db } = await openDb();
    try {
      await db.execute(sql`INSERT INTO pipeline_jobs (type, payload, status, attempts, last_error)
        VALUES ('parse_rpc', '{"signature":"sig-old"}'::jsonb, 'failed', 8, 'maxSupportedTransactionVersion not set')`);
      expect(await requeueVersionedParseFailures(db)).toBe(1);
      const job = asRows<{ status: string; attempts: unknown }>(
        await db.execute(sql`SELECT status, attempts FROM pipeline_jobs`),
      )[0];
      expect(job?.status).toBe("pending");
      expect(asNumber(job?.attempts)).toBe(0);
      await insertRawEvent(db, {
        signature: "sig-orphan",
        slot: 1,
        blockTime: new Date(),
        err: false,
        programs: [],
        source: null,
        wallet,
        mint,
        side: "buy",
        solDelta: -0.4,
        tokenDelta: 10,
        decimals: 6,
        venue: { venue: "pump.fun", graduated: false },
        raw: {},
      });
      expect(await backfillOrphanMints(db, 10)).toBe(1);
      const created = asRows<{ mint: string }>(await db.execute(sql`SELECT mint FROM tokens`));
      expect(created.map((row) => row.mint)).toContain(mint);
      expect(await backfillOrphanMints(db, 10)).toBe(0);
    } finally {
      await client.close();
    }
  });
});
