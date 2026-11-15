import { getToken, listChecks } from "@/lib/db/repo";
import { latestAttempt } from "@/lib/db/verdicts";
import { HttpError, withDb } from "@/lib/http";
import { presentCheck, presentStoredTokens } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ mint: string }> };

export async function GET(_request: Request, context: Context) {
  return withDb(async (db) => {
    const { mint } = await context.params;
    const token = await getToken(db, mint);
    if (!token) throw new HttpError(404, "Token not found.");
    const [checks, verdict] = await Promise.all([listChecks(db, mint, 50), latestAttempt(db, mint)]);
    const [presented] = await presentStoredTokens(db, [token], new Map([[mint, verdict]]));
    return { token: presented, checks: checks.map((row) => presentCheck(row)) };
  });
}
