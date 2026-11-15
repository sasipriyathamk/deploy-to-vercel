import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {sql} from 'drizzle-orm';
import {it,expect,vi} from 'vitest';
import * as schema from '@/lib/db/schema';
import {applyMigrations} from '@/lib/db/migrate';
import {getToken} from '@/lib/db/repo';
import {presentStoredTokens} from '@/lib/present';
it('uses one latest recorded snapshot for list and detail without carrying forward missing fields',async()=>{
 const client=new PGlite();const db=drizzle(client,{schema});
 try{
 vi.stubEnv('ALLOW_ALERT_MIGRATIONS','0');await applyMigrations(db);
 await db.execute(sql`INSERT INTO tokens(mint,status,last_price_usd,last_mcap_usd,last_liq_usd,last_checked_at,entry_at,entry_price_usd) VALUES('quote','watching',999,9999,8888,now(),now()-interval '1 hour',1)`);
 await db.execute(sql`INSERT INTO token_checks(mint,stage,payload,checked_at) VALUES('quote','gain_refresh','{"priceUsd":2,"mcapUsd":1000,"liqUsd":500,"source":"dexscreener"}',now()-interval '1 minute')`);
 await db.execute(sql`INSERT INTO token_checks(mint,stage,payload,checked_at) VALUES('quote','gain_refresh','{"snap":{"priceUsd":3,"mcapUsd":null,"liqUsd":null,"source":"dexscreener","observedAt":"2026-11-12T10:00:00Z"}}',now())`);
 const token=(await getToken(db,'quote'))!;const [shown]=await presentStoredTokens(db,[token]);
 expect(shown.lastPriceUsd).toBe(3);expect(shown.lastMcapUsd).toBeNull();expect(shown.lastLiqUsd).toBeNull();expect(shown.gainPct).toBe(200);expect(shown.lastCheckedAt).toBe('2026-11-12T10:00:00.000Z');expect(shown.quoteSource).toBe('dexscreener');
 }finally{vi.unstubAllEnvs();await client.close();}
});
