import { isSolanaAddress } from "@/lib/logic/address";
import { HttpError, withDb } from "@/lib/http";
import { getDexSnapshots, pairDisplay, type PairDisplay } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MINTS = 30;

/**
 * Light, cached read of DexScreener pair fields the book does not store:
 * 6h/24h volume and social links. 1h volume is already on the token row.
 */
export async function GET(request: Request) {
  return withDb(async (db) => {
    const url = new URL(request.url);
    const mints = [
      ...new Set(
        (url.searchParams.get("mints") ?? "")
          .split(",")
          .map((mint) => mint.trim())
          .filter((mint) => mint.length > 0),
      ),
    ];
    if (mints.length > MAX_MINTS) throw new HttpError(400, "Ask for at most 30 mints.");
    const valid = mints.filter((mint) => isSolanaAddress(mint));
    if (valid.length === 0) return { displays: {} as Record<string, PairDisplay> };
    const snaps = await getDexSnapshots(db, valid);
    const displays: Record<string, PairDisplay> = {};
    for (const mint of valid) displays[mint] = pairDisplay(snaps.get(mint));
    return { displays };
  });
}
