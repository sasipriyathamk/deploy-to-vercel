import { listTokensByStatus, topTokensByStatus } from "@/lib/db/repo";
import { sql } from "drizzle-orm";
import { asRows } from "@/lib/db/rows";
import { HttpError, withDb } from "@/lib/http";
import { presentStoredTokens } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set([
  "seen",
  "candidate",
  "watching",
  "archived",
  "rejected_junk",
]);

export async function GET(request: Request) {
  return withDb(async (db) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "watching";
    if (!STATUSES.has(status)) throw new HttpError(400, "Unknown status.");
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100),
    );
    const rank = url.searchParams.get("rank");
    if (rank != null && rank !== "gain" && rank !== "volume")
      throw new HttpError(400, "Unknown ranking.");
    const rows = rank
      ? await topTokensByStatus(db, status, rank)
      : await listTokensByStatus(
          db,
          status,
          limit,
          url.searchParams.get("order") === "latest",
        );
    if (url.searchParams.get("overview") === "1") {
      const [gainers, volume, count] = await Promise.all([
        topTokensByStatus(db,status,"gain"),topTokensByStatus(db,status,"volume"),
        db.execute(sql`SELECT count(*)::int AS total FROM tokens WHERE status=${status}`),
      ]);
      const unique = [...new Map([...rows,...gainers,...volume].map(row=>[row.mint,row])).values()];
      const presented = new Map((await presentStoredTokens(db,unique)).map(row=>[row.mint,row]));
      return {tokens:rows.map(row=>presented.get(row.mint)),gainers:gainers.map(row=>presented.get(row.mint)),volume:volume.map(row=>presented.get(row.mint)),total:asRows<{total:number}>(count)[0].total};
    }
    return { tokens: await presentStoredTokens(db, rows) };
  });
}
