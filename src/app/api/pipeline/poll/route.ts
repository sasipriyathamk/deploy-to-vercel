import { withDb } from "@/lib/http";
import { runCron } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  return withDb((db) => runCron(db, "poll"));
}
