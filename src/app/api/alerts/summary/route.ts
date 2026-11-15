import { withDb } from "@/lib/http";
import { alertSummary } from "@/lib/alerts/summary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Like /api/health and /api/tokens, this supports the existing unauthenticated research UI.
// No credential values, destination IDs, delivery errors or full snapshots are exposed.
export async function GET() {
  return withDb((db) => alertSummary(db));
}
