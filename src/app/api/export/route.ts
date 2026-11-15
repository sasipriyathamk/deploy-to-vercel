import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db/index";
import { exportStream } from "@/lib/db/export";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  const secret = process.env.EXPORT_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || Buffer.byteLength(provided)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))
    return Response.json({error:"A valid export key is required."},{status:401,headers:{"Cache-Control":"no-store"}});
  const db=await getDb();
  return new Response(exportStream(db,request.signal),{headers:{
    "Content-Type":"application/x-ndjson; charset=utf-8",
    "Content-Disposition":`attachment; filename="keel-database-${new Date().toISOString().replaceAll(':','-')}.jsonl"`,
    "Cache-Control":"no-store, private", "X-Content-Type-Options":"nosniff",
  }});
}
