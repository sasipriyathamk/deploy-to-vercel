import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "@/lib/db/migrate";
import { topTokensByStatus, copyFirstAlertToEntry, dataQualityCounts, insertRawEvent, listTokensByStatus, stampEntryIfEmpty } from "@/lib/db/repo";
import { asRows } from "@/lib/db/rows";
import * as schema from "@/lib/db/schema";

describe("postgres schema", () => {
  it("dedupes signatures and refuses to overwrite entry", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    const applied = await applyMigrations(db);
    expect(applied).toEqual([
      "0001_init.sql",
      "0002_seed_wallet.sql",
      "0003_token_image.sql",
      "0004_candidate_confidence.sql",
      "0005_ai_verdicts.sql",
      "0006_parse_queue.sql",
    ]);
    const quality = await dataQualityCounts(db);
    expect(Number(quality.no_dex_pair)).toBe(0);
    expect(Number(quality.parse_gap)).toBe(0);
    const imageColumn = asRows<{ column_name: string }>(
      await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'tokens' AND column_name = 'image_url'`),
    );
    expect(imageColumn).toHaveLength(1);

    const wallets = asRows<{ address: string }>(await db.execute(sql`SELECT address FROM wallets`));
    expect(wallets.map((row) => row.address)).toContain("STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk");

    const event = {
      signature: "sig-once",
      slot: 1,
      blockTime: new Date("2026-11-09T12:00:00Z"),
      err: false,
      programs: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
      source: "PUMP_FUN",
      wallet: "STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk",
      mint: "Mint111111111111111111111111111111111111111",
      side: "buy" as const,
      solDelta: -0.4,
      tokenDelta: 1000,
      decimals: 6,
      venue: { venue: "pump.fun", graduated: false },
      raw: { ok: true },
    };
    expect(await insertRawEvent(db, event)).toBe(true);
    expect(await insertRawEvent(db, { ...event, solDelta: -9 })).toBe(false);
    const count = asRows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM raw_events`));
    expect(Number(count[0]?.n)).toBe(1);

    await db.execute(sql`INSERT INTO tokens (mint, status, score) VALUES ('Mint111111111111111111111111111111111111111', 'candidate', 50)`);
    await stampEntryIfEmpty(db, "Mint111111111111111111111111111111111111111", {
      at: new Date("2026-11-09T12:15:00Z"),
      priceUsd: 0.02,
      mcapUsd: 10_000,
    });
    await stampEntryIfEmpty(db, "Mint111111111111111111111111111111111111111", {
      at: new Date("2026-11-09T18:00:00Z"),
      priceUsd: 4,
      mcapUsd: 9_000_000,
    });
    const token = asRows<{ entry_price_usd: number; entry_mcap_usd: number; entry_at: string }>(
      await db.execute(sql`SELECT entry_price_usd, entry_mcap_usd, entry_at FROM tokens`),
    );
    expect(Number(token[0]?.entry_price_usd)).toBeCloseTo(0.02);
    expect(Number(token[0]?.entry_mcap_usd)).toBeCloseTo(10_000);
    expect(new Date(token[0]!.entry_at).toISOString()).toBe("2026-11-09T12:15:00.000Z");

    await db.execute(sql`UPDATE tokens SET
      first_alert_at = '2026-11-09T12:00:00Z',
      first_alert_price_usd = 0.004,
      first_alert_mcap_usd = 404000
      WHERE mint = 'Mint111111111111111111111111111111111111111'`);
    await copyFirstAlertToEntry(db, "Mint111111111111111111111111111111111111111");
    const kept = asRows<{ entry_price_usd: number }>(
      await db.execute(sql`SELECT entry_price_usd FROM tokens WHERE mint = 'Mint111111111111111111111111111111111111111'`),
    );
    expect(Number(kept[0]?.entry_price_usd)).toBeCloseTo(0.02);

    await db.execute(sql`INSERT INTO tokens (mint, status, score) VALUES ('MintNeverCandidate111111111111111111111111', 'seen', 50)`);
    await copyFirstAlertToEntry(db, "MintNeverCandidate111111111111111111111111");
    const invented = asRows<{ entry_at: string | null }>(
      await db.execute(sql`SELECT entry_at FROM tokens WHERE mint = 'MintNeverCandidate111111111111111111111111'`),
    );
    expect(invented[0]?.entry_at ?? null).toBeNull();

    await db.execute(sql`INSERT INTO tokens (mint, status, score, first_alert_at, first_alert_price_usd, first_alert_mcap_usd, confidence, cap_regime)
      VALUES
        ('MintFresh111111111111111111111111111111111111', 'candidate', 50, '2026-11-09T12:05:00Z', 0.004, 404000, 60, 'fresh'),
        ('MintExtended111111111111111111111111111111111', 'candidate', 90, '2026-11-09T10:00:00Z', 0.01, 9200000, 88, 'extended')`);
    await copyFirstAlertToEntry(db, "MintFresh111111111111111111111111111111111111");
    await copyFirstAlertToEntry(db, "MintFresh111111111111111111111111111111111111");
    const copied = asRows<{ entry_price_usd: number; entry_mcap_usd: number; entry_at: string }>(
      await db.execute(sql`SELECT entry_price_usd, entry_mcap_usd, entry_at FROM tokens WHERE mint = 'MintFresh111111111111111111111111111111111111'`),
    );
    expect(Number(copied[0]?.entry_price_usd)).toBeCloseTo(0.004);
    expect(Number(copied[0]?.entry_mcap_usd)).toBeCloseTo(404_000);
    expect(new Date(copied[0]!.entry_at).toISOString()).toBe("2026-11-09T12:05:00.000Z");

    const ranked = await listTokensByStatus(db, "candidate", 10);
    expect(ranked.map((row) => row.mint)).toEqual([
      "MintFresh111111111111111111111111111111111111",
      "Mint111111111111111111111111111111111111111",
      "MintExtended111111111111111111111111111111111",
    ]);
    await client.close();
  });
});

it("applies latest discovery order before the list limit", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    await applyMigrations(db);
    await db.execute(sql`INSERT INTO tokens(mint,status,score,first_seen_at) VALUES
      ('older','watching',100,'2026-11-10T10:00:00Z'),
      ('newest','watching',50,'2026-11-12T10:00:00Z'),
      ('unknown','watching',100,NULL)`);
    expect((await listTokensByStatus(db,"watching",1,true)).map(t=>t.mint)).toEqual(["newest"]);
  } finally { await client.close(); }
});


it("ranks the whole book before taking ten, with positive metrics and stable ties", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    await applyMigrations(db);
    await db.execute(sql`INSERT INTO tokens(mint,status,score,gain_pct,last_vol_h1,first_seen_at)
      SELECT 'mint-' || lpad(i::text,4,'0'), 'watching',50,i-100,300-i,
        '2026-11-10'::timestamptz + i * interval '1 minute'
      FROM generate_series(1,210) i`);
    await db.execute(sql`INSERT INTO tokens(mint,status,score,gain_pct,last_vol_h1) VALUES
      ('tie-a','watching',50,999,NULL),('tie-b','watching',50,999,NULL),
      ('no-metrics','watching',50,NULL,NULL),('zero','watching',50,0,0),
      ('negative','watching',50,-1,-1),('other-status','candidate',50,9999,9999)`);
    const gain = await topTokensByStatus(db,"watching","gain");
    expect(gain).toHaveLength(10);
    expect(gain.slice(0,3).map(t=>t.mint)).toEqual(['tie-a','tie-b','mint-0210']);
    expect(gain.every(t=>t.status==='watching' && (t.gainPct ?? 0)>0)).toBe(true);
    const volume = await topTokensByStatus(db,"watching","volume");
    expect(volume).toHaveLength(10);
    expect(volume[0].mint).toBe('mint-0001');
    expect(volume[0].gainPct).toBeLessThan(0);
    expect(volume.every(t=>(t.lastVolH1 ?? 0)>0)).toBe(true);
    expect(await topTokensByStatus(db,"archived","gain")).toEqual([]);
  } finally { await client.close(); }
});
