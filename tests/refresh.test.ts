import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "@/lib/db/migrate";
import { gainRefreshMints, watchingFreshness } from "@/lib/db/repo";
import { asRows } from "@/lib/db/rows";
import * as schema from "@/lib/db/schema";
import * as market from "@/lib/market";
import { refreshGains } from "@/lib/pipeline";

const client = new PGlite();
const db = drizzle(client, { schema });
const snapshot = { ...market.emptySnapshot("dexscreener"), priceUsd: 1, mcapUsd: 10000, liqUsd: 5000, pairCount: 1 };
async function seed(n: number) {
  await db.execute(sql`INSERT INTO tokens(mint,status,score,last_checked_at,entry_at,entry_price_usd)
    SELECT 'mint-' || lpad(i::text,4,'0'),'watching',50,now()-interval '2 hours',now()-interval '3 hours',1
    FROM generate_series(1,${n}) i`);
}
function dex() {
  return vi.spyOn(market, "getDexSnapshots").mockImplementation(async (_db, mints) => new Map(mints.map(mint => [mint, snapshot])));
}
beforeAll(async () => { await applyMigrations(db); }, 30_000);
beforeEach(async () => {
  await db.execute(sql`TRUNCATE token_checks,tokens`);
  vi.spyOn(market, "getJupiterPrices").mockResolvedValue(new Map());
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await client.close(); });

describe("bounded refresh coverage", () => {
  it("rotates oldest-first through a 516-token book across bounded runs", async () => {
    await seed(516);
    const fetch = dex();
    for (const expected of [200,200,116]) {
      const result = await refreshGains(db, { limit: expected, deadline: Date.now()+45000 });
      expect(result.updated).toBe(expected);
    }
    expect(fetch.mock.calls.every(([,mints]) => mints.length<=30)).toBe(true);
    const covered = asRows<{ n: number }>(await db.execute(sql`SELECT count(DISTINCT mint)::int AS n FROM token_checks WHERE stage='gain_refresh'`));
    expect(covered[0].n).toBe(516);
    expect(await watchingFreshness(db)).toMatchObject({ total:516, stale30m:0, neverChecked:0 });
  });
  it("persists the first batch and stops admitting requests near its deadline", async () => {
    await seed(65);
    let clock=1000;
    vi.spyOn(Date,"now").mockImplementation(()=>clock);
    const fetch=dex().mockImplementation(async (_db,mints)=> {
      clock=15000;
      return new Map(mints.map(mint=>[mint,snapshot]));
    });
    expect(await refreshGains(db,{deadline:26000})).toEqual({updated:30});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(market.getJupiterPrices).not.toHaveBeenCalled();
  });
  it("does not write late provider results after the deadline", async () => {
    await seed(1);
    let clock = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    dex().mockImplementation(async (_db, mints) => {
      clock = 30000;
      return new Map(mints.map(mint => [mint, snapshot]));
    });
    expect(await refreshGains(db, { deadline: 26000 })).toEqual({ updated: 0 });
    vi.mocked(Date.now).mockRestore();
    expect((await watchingFreshness(db)).stale30m).toBe(1);
  });
  it("does no provider work with insufficient headroom",async()=>{
    await seed(1);const fetch=dex();
    expect(await refreshGains(db,{deadline:Date.now()+1000})).toEqual({updated:0});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not request a second price source when complete Dex quotes are available",async()=>{
    await seed(65);dex();
    vi.mocked(market.getJupiterPrices).mockRejectedValue(new market.RateLimitError("jupiter",15000,"budget"));
    expect(await refreshGains(db,{deadline:Date.now()+45000})).toEqual({updated:65});
    expect(market.getJupiterPrices).not.toHaveBeenCalled();
  });
  it("surfaces primary-provider failures when no fallback data is available", async () => {
    await seed(1);
    vi.spyOn(market, "getDexSnapshots").mockRejectedValue(new Error("DexScreener HTTP 503"));
    await expect(refreshGains(db, { deadline: Date.now() + 45000 })).rejects.toThrow("DexScreener HTTP 503");
    expect((await watchingFreshness(db)).stale30m).toBe(1);
  });
  it("stops on the primary provider budget without retrying every batch",async()=>{
    await seed(65);
    const fetch=vi.spyOn(market,"getDexSnapshots").mockRejectedValue(new market.RateLimitError("dexscreener",15000,"budget"));
    expect(await refreshGains(db,{deadline:Date.now()+45000})).toEqual({updated:0});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await watchingFreshness(db)).stale30m).toBe(65);
  });
  it("does not mark empty responses as fresh or starve later batches",async()=>{
    await seed(31);
    const fetch=dex().mockImplementation(async (_db,mints)=>new Map(mints.map(mint=>[mint,mints.length===30?market.emptySnapshot():snapshot])));
    expect(await refreshGains(db,{deadline:Date.now()+45000})).toEqual({updated:1});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await watchingFreshness(db)).stale30m).toBe(30);
  });
  it("reports never-checked tokens and selects them before checked rows",async()=>{
    await seed(2);
    await db.execute(sql`UPDATE tokens SET last_checked_at=NULL WHERE mint='mint-0002'`);
    expect(await gainRefreshMints(db,1)).toEqual(['mint-0002']);
    const freshness=await watchingFreshness(db);
    expect(freshness).toMatchObject({total:2,neverChecked:1,stale30m:2});
    expect(freshness.p50CheckAgeSeconds).toBeGreaterThan(7100);
    await db.execute(sql`TRUNCATE token_checks,tokens`);
    expect(await watchingFreshness(db)).toEqual({total:0,neverChecked:0,stale30m:0,p50CheckAgeSeconds:null,p95CheckAgeSeconds:null});
  });
});
