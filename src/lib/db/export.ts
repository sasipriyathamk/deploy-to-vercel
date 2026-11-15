import { sql } from "drizzle-orm";
import type { AppDb } from "./index";
import { asRows } from "./rows";
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
/** One read-only MVCC snapshot, bounded server buffers; completion footer proves success. */
export async function exportRecords(db: AppDb, emit: (record: unknown) => Promise<void>) {
  const totals = await db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const tables = asRows<{ table_name: string }>(await tx.execute(sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`));
    await emit({type:"manifest",format:"keel-database-jsonl",version:1,rowEncoding:"postgres-json-text",startedAt:new Date().toISOString(),schema:"public",tables:tables.map(t=>t.table_name)});
    let total = 0;
    for (const { table_name: table } of tables) {
      const columns = asRows(await tx.execute(sql`SELECT column_name,data_type,udt_name,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`));
      await emit({type:"table",table,columns});
      await tx.execute(sql.raw(`DECLARE keel_export NO SCROLL CURSOR FOR SELECT to_jsonb(r)::text AS record FROM public.${identifier(table)} r`));
      let count = 0;
      try {
        for (;;) {
          const rows = asRows<{record:unknown}>(await tx.execute(sql`FETCH FORWARD 200 FROM keel_export`));
          if (!rows.length) break;
          for (const row of rows) { await emit({type:"row",table,record:row.record}); count++; }
        }
      } finally { await tx.execute(sql`CLOSE keel_export`); }
      total += count;
      await emit({type:"table_complete",table,rows:count});
    }
    return {tables:tables.length,rows:total};
  });
  await emit({type:"complete",...totals,completedAt:new Date().toISOString()});
}
export function exportStream(db: AppDb, signal: AbortSignal) {
  let cancelled = false;
  const encoder = new TextEncoder();
  const deadline = Date.now()+50000;
  let buffer="";
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        async function flush() {
          if(!buffer) return;
          while ((controller.desiredSize ?? 0)<=0 && !cancelled && !signal.aborted && Date.now()<deadline)
            await new Promise(resolve=>setTimeout(resolve,10));
          if(cancelled || signal.aborted || Date.now()>=deadline) throw new Error("Export interrupted; retry the download");
          controller.enqueue(encoder.encode(buffer));buffer="";
        }
        await exportRecords(db,async record => {
          if(cancelled || signal.aborted || Date.now()>=deadline) throw new Error("Export interrupted; retry the download");
          buffer+=JSON.stringify(record)+"\n";
          if(buffer.length>=65536) await flush();
        });
        await flush();
        if (!cancelled) controller.close();
      } catch(error) { if(!cancelled) controller.error(error); }
    },
    cancel(){cancelled=true;},
  });
}
