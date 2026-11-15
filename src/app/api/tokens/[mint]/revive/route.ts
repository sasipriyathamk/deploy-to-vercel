import { HttpError, withDb } from "@/lib/http";
import { reviveToken } from "@/lib/pipeline";
import { presentStoredTokens } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ mint: string }> };

export async function POST(_request: Request, context: Context) {
  return withDb(async (db) => {
    const { mint } = await context.params;
    const token = await reviveToken(db, mint);
    if (!token) throw new HttpError(404, "Token not found.");
    if (token.status !== "watching") throw new HttpError(400, "Only archived tokens can be revived.");
    const [presented] = await presentStoredTokens(db, [token]);
    return { token: presented };
  });
}
