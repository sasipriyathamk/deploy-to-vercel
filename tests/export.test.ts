import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { it,expect } from "vitest";
import { exportRecords } from "@/lib/db/export";
import * as schema from "@/lib/db/schema";
it("exports every public table, nulls and nested data with reconciled row counts",async()=>{
  const client=new PGlite();const db=drizzle(client,{schema});
  try {
    await db.execute(sql`CREATE TABLE first_records(id bigint,payload jsonb,missing text)`);
    await db.execute(sql`CREATE TABLE empty_records(id integer)`);
    await db.execute(sql`INSERT INTO first_records VALUES(9007199254740993,'{"price":null,"nested":[1,2]}'::jsonb,NULL)`);
    const records:unknown[]=[];await exportRecords(db,async row=>{records.push(row);});
    expect(records[0]).toMatchObject({type:'manifest',tables:['empty_records','first_records']});
    const row=records.find(row=>(row as {type:string}).type==='row') as {record:string};
    expect(row.record).toContain("9007199254740993");
    expect(JSON.parse(row.record)).toEqual({id:9007199254740992,payload:{price:null,nested:[1,2]},missing:null});
    expect(records.at(-1)).toMatchObject({type:'complete',tables:2,rows:1});
    expect(records).toContainEqual({type:'table_complete',table:'empty_records',rows:0});
  }finally{await client.close();}
});
it("does not mark an interrupted export complete",async()=>{
  const client=new PGlite();const db=drizzle(client,{schema});const records:unknown[]=[];
  try {
    await db.execute(sql`CREATE TABLE example(id integer)`);
    await expect(exportRecords(db,async row=>{records.push(row);if(records.length===2)throw new Error('disconnected');})).rejects.toThrow('disconnected');
    expect(records.some(row=>(row as {type:string}).type==='complete')).toBe(false);
  }finally{await client.close();}
});
