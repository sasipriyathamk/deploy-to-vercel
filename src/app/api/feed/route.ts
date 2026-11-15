import { recentBuys } from "@/lib/db/repo";
import { withDb } from "@/lib/http";
import { presentBuy } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withDb(async (db) => {
    const limit = Math.min(80, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 40) || 40));
    const rows = await recentBuys(db, limit);
    return { buys: rows.map((row) => presentBuy(row)) };
  });
}
