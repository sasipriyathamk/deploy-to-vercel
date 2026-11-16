import { withDb } from "@/lib/http";
import {
  getCalibration,
  refreshCalibration,
  CONFIDENCE_BANDS,
  FORWARD_WINDOWS,
} from "@/lib/paper/calibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/paper/calibration — returns cached calibration rows */
export async function GET() {
  return withDb(async (db) => {
    const rows = await getCalibration(db);
    return {
      bands: CONFIDENCE_BANDS,
      windows: FORWARD_WINDOWS,
      rows,
      methodology:
        "Calibration uses sent Telegram alert observations. " +
        "Confidence is locked at the time of alert sending (no look-ahead). " +
        "Censored: window not yet complete. MFE/MAE: best/worst sampled price in the window. " +
        "Gaps in observations are preserved; no interpolation is applied.",
    };
  });
}

/** POST /api/paper/calibration — refreshes the calibration cache */
export async function POST() {
  return withDb(async (db) => {
    const result = await refreshCalibration(db);
    return { refreshed: true, ...result };
  });
}
