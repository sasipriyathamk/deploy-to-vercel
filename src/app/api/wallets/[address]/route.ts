import { eq } from "drizzle-orm";
import { wallets } from "@/lib/db/schema";
import { HttpError, withDb } from "@/lib/http";
import { isSolanaAddress } from "@/lib/logic/address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ address: string }> };

export async function PATCH(request: Request, context: Context) {
  return withDb(async (db) => {
    const { address } = await context.params;
    if (!isSolanaAddress(address)) throw new HttpError(400, "Unknown wallet.");
    const body = (await request.json().catch(() => null)) as { enabled?: boolean; label?: string } | null;
    const patch: { enabled?: boolean; label?: string } = {};
    if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body?.label === "string") patch.label = body.label.trim().slice(0, 80);
    if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to update.");
    const updated = await db.update(wallets).set(patch).where(eq(wallets.address, address)).returning();
    if (updated.length === 0) throw new HttpError(404, "Wallet not found.");
    return { ok: true };
  });
}

export async function DELETE(_request: Request, context: Context) {
  return withDb(async (db) => {
    const { address } = await context.params;
    await db.delete(wallets).where(eq(wallets.address, address));
    return { ok: true };
  });
}
