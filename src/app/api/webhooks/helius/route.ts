import { flushAlerts } from "@/lib/alerts/telegram";
import { after, NextResponse } from "next/server";
import { getDb } from "@/lib/db/index";
import { unauthorized, webhookAuthorized } from "@/lib/http";
import { ingestHelius, processQueue } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!webhookAuthorized(request)) return unauthorized();
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, received: 0, stored: 0, queued: 0 });
  }
  try {
    const db = await getDb();
    const result = await ingestHelius(db, body);
    after(async () => {
      const deadline = Date.now() + 45_000;
      try {
        await processQueue(db, 6, 8_000);
        await flushAlerts(db, deadline);
      } catch { console.error("[keel] webhook follow-up failed"); }
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[keel] webhook", error);
    return NextResponse.json({ error: "Webhook ingest failed." }, { status: 500 });
  }
}
