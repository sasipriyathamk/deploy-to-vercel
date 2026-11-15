import { eq } from "drizzle-orm";
import { wallets } from "@/lib/db/schema";
import { walletRows } from "@/lib/db/repo";
import { HttpError, withDb } from "@/lib/http";
import { isSolanaAddress } from "@/lib/logic/address";
import { presentWallet } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(async (db) => {
    const rows = await walletRows(db);
    return { wallets: rows.map((row) => presentWallet(row)) };
  });
}

export async function POST(request: Request) {
  return withDb(async (db) => {
    const body = (await request.json().catch(() => null)) as { address?: string; label?: string } | null;
    const address = body?.address?.trim() ?? "";
    if (!isSolanaAddress(address)) throw new HttpError(400, "Enter a Solana wallet address.");
    const label = (body?.label ?? "").trim().slice(0, 80);
    await db.insert(wallets).values({ address, label, enabled: true }).onConflictDoNothing({ target: wallets.address });
    const existing = await db.select().from(wallets).where(eq(wallets.address, address)).limit(1);
    if (existing[0] && label && existing[0].label !== label) {
      await db.update(wallets).set({ label }).where(eq(wallets.address, address));
    }
    const rows = await walletRows(db);
    const wallet = rows.map((row) => presentWallet(row)).find((row) => row.address === address);
    return { wallet };
  });
}
