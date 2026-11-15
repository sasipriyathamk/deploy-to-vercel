import { pipelineStats } from "@/lib/db/repo";
import { withDb } from "@/lib/http";
import { presentStats } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(async (db) => presentStats(await pipelineStats(db)));
}
