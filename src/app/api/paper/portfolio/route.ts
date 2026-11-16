import { withDb } from "@/lib/http";
import { listPortfolios, createPortfolio, getEquityCurve } from "@/lib/paper/store";
import { portfolioSummary } from "@/lib/paper/stats";
import { ensureDefaultPortfolio, DEFAULT_STRATEGY } from "@/lib/paper/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withDb(async (db) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      const summary = await portfolioSummary(db, Number(id));
      const curve = await getEquityCurve(db, Number(id));
      return { summary, equityCurve: curve };
    }
    return listPortfolios(db);
  });
}

export async function POST(request: Request) {
  return withDb(async (db) => {
    const body = await request.json().catch(() => ({}));
    if (body.action === "ensure_default") {
      const id = await ensureDefaultPortfolio(db);
      return { id };
    }
    if (body.name) {
      const id = await createPortfolio(db, {
        name: body.name,
        strategy_id: body.strategy_id ?? "default",
        strategy_version: body.strategy_version ?? 1,
        starting_capital: body.starting_capital ?? 1000,
        position_sizing: body.position_sizing ?? "fixed_dollar",
        position_size: body.position_size ?? 100,
        max_positions: body.max_positions ?? 5,
        max_exposure_per_token: body.max_exposure_per_token ?? 0.2,
        max_total_exposure: body.max_total_exposure ?? 0.8,
      });
      return { id };
    }
    return { error: "Missing name" };
  });
}
