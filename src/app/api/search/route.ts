import { searchTokens, searchWallets } from "@/lib/db/repo";
import { withDb } from "@/lib/http";
import { likeContains } from "@/lib/logic/address";
import { presentStoredTokens } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withDb(async (db) => {
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (query.length < 1) return { query, tokens: [], wallets: [] };
    const like = likeContains(query.slice(0, 80));
    const [tokens, wallets] = await Promise.all([searchTokens(db, like, 50), searchWallets(db, like)]);
    return { query, tokens: await presentStoredTokens(db, tokens), wallets };
  });
}
