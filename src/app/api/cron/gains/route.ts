import { cronAuthorized, unauthorized, withDb } from "@/lib/http";
import { runCron } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return unauthorized();
  return withDb((db) => runCron(db, "gains"));
}
