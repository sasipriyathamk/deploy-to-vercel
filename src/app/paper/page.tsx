"use client";

import { useEffect, useState, useCallback } from "react";
import type { CalibrationRow } from "@/lib/paper/calibration";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------
type StatsData = {
  universe: Record<string, unknown> | null;
  recentPerformance: Array<Record<string, unknown>>;
  drawdownSummary: Record<string, unknown> | null;
  drawdownChart: Array<Record<string, unknown>>;
};

type CalibrationData = {
  bands: Array<{ lo: number; hi: number; label: string }>;
  windows: number[];
  rows: CalibrationRow[];
};

type PortfolioData = {
  summary: {
    portfolio: Record<string, unknown>;
    positions: Record<string, unknown>;
    equity: Record<string, unknown>;
    drawdown: Record<string, unknown>;
  } | null;
  equityCurve: Array<Record<string, unknown>>;
};

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function fmt(n: number | null | undefined, decimals = 1, suffix = ""): string {
  if (n == null) return "–";
  return `${n.toFixed(decimals)}${suffix}`;
}
function fmtPct(n: number | null | undefined): string {
  return fmt(n, 1, "%");
}
function fmtMins(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 60) return `${n.toFixed(0)}m`;
  return `${(n / 60).toFixed(1)}h`;
}

function Badge({ value, good }: { value: string; good: boolean }) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono font-semibold ${
        good ? "bg-green-900/60 text-green-300" : "bg-red-900/60 text-red-300"
      }`}
    >
      {value}
    </span>
  );
}

// ----------------------------------------------------------------
// Confidence Calibration Table
// ----------------------------------------------------------------
function CalibrationTable({ data, windowMin }: { data: CalibrationData; windowMin: number }) {
  const rows = data.rows.filter((r) => r.window_minutes === windowMin);
  if (rows.length === 0)
    return (
      <p className="text-sm text-zinc-500 mt-2">
        No calibration data yet. Click <strong>Refresh Calibration</strong>.
      </p>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr className="text-zinc-400 border-b border-zinc-700">
            <th className="text-left py-1 pr-3">Band</th>
            <th className="text-right pr-2">n</th>
            <th className="text-right pr-2">w/data</th>
            <th className="text-right pr-2">+25%</th>
            <th className="text-right pr-2">+50%</th>
            <th className="text-right pr-2">+100%</th>
            <th className="text-right pr-2">+200%</th>
            <th className="text-right pr-2">-30%</th>
            <th className="text-right pr-2">-50%</th>
            <th className="text-right pr-2">MFE</th>
            <th className="text-right pr-2">MAE</th>
            <th className="text-right pr-2">2× before -30%</th>
            <th className="text-right">Censored</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.confidence_lo}-${r.window_minutes}`}
              className="border-b border-zinc-800 hover:bg-zinc-800/40"
            >
              <td className="py-1 pr-3 font-semibold text-zinc-200">
                {r.confidence_lo === 90 ? "90+" : `${r.confidence_lo}–${r.confidence_hi}`}
              </td>
              <td className="text-right pr-2 text-zinc-400">{r.n_signals}</td>
              <td className="text-right pr-2 text-zinc-400">{r.n_with_data}</td>
              <td className="text-right pr-2">{fmtPct(r.pct_plus25)}</td>
              <td className="text-right pr-2">{fmtPct(r.pct_plus50)}</td>
              <td className="text-right pr-2">
                {r.pct_plus100 != null ? (
                  <Badge value={fmtPct(r.pct_plus100)} good={(r.pct_plus100 ?? 0) > 20} />
                ) : "–"}
              </td>
              <td className="text-right pr-2">{fmtPct(r.pct_plus200)}</td>
              <td className="text-right pr-2 text-orange-400">{fmtPct(r.pct_minus30)}</td>
              <td className="text-right pr-2 text-red-400">{fmtPct(r.pct_minus50)}</td>
              <td className="text-right pr-2 text-green-400">{fmtPct(r.median_mfe)}</td>
              <td className="text-right pr-2 text-red-400">{fmtPct(r.median_mae)}</td>
              <td className="text-right pr-2">
                {r.prob_2x_before_30 != null ? (
                  <Badge value={fmtPct(r.prob_2x_before_30)} good={(r.prob_2x_before_30 ?? 0) > 30} />
                ) : "–"}
              </td>
              <td className="text-right text-zinc-500">
                {r.n_censored > 0 ? `${r.n_censored}⚠` : "0"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-zinc-600 mt-1">
        ⚠ = observations whose {windowMin / 60 >= 1 ? `${windowMin / 60}h` : `${windowMin}m`} window is not yet complete (censored outcomes).
        MFE/MAE = best/worst sampled price in the window. No interpolation.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------
// Drawdown summary
// ----------------------------------------------------------------
function DrawdownSection({ summary, chart }: {
  summary: Record<string, unknown> | null;
  chart: Array<Record<string, unknown>>;
}) {
  if (!summary) return <p className="text-sm text-zinc-500">No drawdown episodes recorded yet.</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Episodes", value: String(summary.total_episodes ?? 0) },
          { label: "Resolved", value: String(summary.resolved ?? 0) },
          { label: "Failed", value: String(summary.failed ?? 0) },
          { label: "Recovered to High", value: String(summary.recovered_to_high ?? 0) },
        ].map((s) => (
          <div key={s.label} className="bg-zinc-800/50 rounded p-2">
            <div className="text-xs text-zinc-400">{s.label}</div>
            <div className="text-lg font-mono font-semibold text-zinc-100">{s.value}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <span className="text-zinc-400">Median depth: </span>
          <span className="font-mono">{fmtPct(summary.median_depth_pct as number)}</span>
        </div>
        <div>
          <span className="text-zinc-400">Median trough time: </span>
          <span className="font-mono">{fmtMins(summary.median_minutes_to_trough as number)}</span>
        </div>
        <div>
          <span className="text-zinc-400">Median rebound: </span>
          <span className="font-mono">{fmtPct(summary.median_rebound_pct as number)}</span>
        </div>
      </div>
      {chart.length > 0 && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Recovery rate by drawdown depth bucket</div>
          <div className="flex items-end gap-1 h-16">
            {chart.map((row) => {
              const rate = Number(row.recovery_rate_pct ?? 0);
              return (
                <div key={String(row.depth_bucket)} className="flex flex-col items-center gap-0.5 flex-1">
                  <div
                    className="w-full bg-blue-500/60 rounded-t"
                    style={{ height: `${(rate / 100) * 56}px` }}
                    title={`${row.depth_bucket}%: ${rate.toFixed(0)}% recovery`}
                  />
                  <div className="text-[9px] text-zinc-500 rotate-0">
                    {String(row.depth_bucket)}%
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-xs text-zinc-600 mt-1">
            Bar height = % of episodes that recovered to their local high.
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// Recent performance list
// ----------------------------------------------------------------
function RecentPerformance({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0)
    return <p className="text-sm text-zinc-500">No sent alerts yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr className="text-zinc-400 border-b border-zinc-700">
            <th className="text-left py-1 pr-2">Token</th>
            <th className="text-right pr-2">Conf</th>
            <th className="text-right pr-2">Latest</th>
            <th className="text-right pr-2">MFE</th>
            <th className="text-right pr-2">MAE</th>
            <th className="text-right pr-2">Max DD</th>
            <th className="text-right">Milestones</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((r) => (
            <tr key={String(r.id)} className="border-b border-zinc-800 hover:bg-zinc-800/40">
              <td className="py-1 pr-2 max-w-[80px] truncate text-zinc-200">
                {String(r.symbol ?? r.mint ?? "")}
              </td>
              <td className="text-right pr-2 text-zinc-400">{String(r.confidence ?? "–")}</td>
              <td className={`text-right pr-2 ${Number(r.latest_return_pct ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                {fmtPct(r.latest_return_pct as number)}
              </td>
              <td className="text-right pr-2 text-green-400">{fmtPct(r.mfe_pct as number)}</td>
              <td className="text-right pr-2 text-red-400">{fmtPct(r.mae_pct as number)}</td>
              <td className="text-right pr-2 text-orange-400">{fmtPct(r.max_drawdown_pct as number)}</td>
              <td className="text-right">
                {Array.isArray(r.milestones) && r.milestones.length > 0
                  ? r.milestones.map((m: number) => `${m}×`).join(" ")
                  : "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-zinc-600 mt-1">
        Sampled estimates only. No fees or slippage. Gaps in observations preserved as unknown.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------
// Portfolio summary
// ----------------------------------------------------------------
function PortfolioSection({ data }: { data: PortfolioData | null }) {
  if (!data?.summary) return (
    <p className="text-sm text-zinc-500">
      No portfolio yet. POST /api/paper/portfolio with {"{ action: 'ensure_default' }"} to create one.
    </p>
  );

  const { portfolio, positions, equity, drawdown } = data.summary;
  const curve = data.equityCurve;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        {[
          { label: "Starting Capital", value: `$${Number(portfolio.starting_capital ?? 0).toFixed(0)}` },
          { label: "Open Positions", value: String(positions?.open_positions ?? 0) },
          { label: "Total Realised P&L", value: `$${Number(positions?.total_realised_pnl ?? 0).toFixed(2)}` },
          { label: "Win Rate", value: fmtPct(
            positions?.winners != null && positions?.losers != null
              ? (Number(positions.winners) / Math.max(1, Number(positions.winners) + Number(positions.losers))) * 100
              : null
          ) },
        ].map((s) => (
          <div key={s.label} className="bg-zinc-800/50 rounded p-2">
            <div className="text-xs text-zinc-400">{s.label}</div>
            <div className="text-base font-mono font-semibold text-zinc-100">{s.value}</div>
          </div>
        ))}
      </div>

      {curve.length > 1 && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Equity curve (simulated)</div>
          <div className="flex items-end gap-0.5 h-20">
            {curve.map((snap, i) => {
              const eq = Number(snap.equity ?? 0);
              const start = Number(portfolio.starting_capital ?? 1000);
              const pct = Math.max(10, Math.min(100, (eq / start) * 60));
              return (
                <div
                  key={i}
                  className={`flex-1 rounded-t ${eq >= start ? "bg-green-500/50" : "bg-red-500/50"}`}
                  style={{ height: `${pct}px` }}
                  title={`${String(snap.snapshot_date)}: $${eq.toFixed(2)}`}
                />
              );
            })}
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Simulated equity. Labelled as estimate. Slippage {DEFAULT_SLIPPAGE}% per side + fee applied.
          </p>
        </div>
      )}

      <div className="text-sm grid grid-cols-3 gap-2">
        <div>
          <span className="text-zinc-400">Portfolio max drawdown: </span>
          <span className="font-mono text-red-400">{fmtPct(drawdown?.max_drawdown as number)}</span>
        </div>
        <div>
          <span className="text-zinc-400">Winners: </span>
          <span className="font-mono text-green-400">{String(positions?.winners ?? 0)}</span>
        </div>
        <div>
          <span className="text-zinc-400">Losers: </span>
          <span className="font-mono text-red-400">{String(positions?.losers ?? 0)}</span>
        </div>
      </div>
    </div>
  );
}

const DEFAULT_SLIPPAGE = 0.5;

// ----------------------------------------------------------------
// Main page component
// ----------------------------------------------------------------
export default function PaperTradingPage() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [calibration, setCalibration] = useState<CalibrationData | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [calWindow, setCalWindow] = useState(60);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"calibration" | "drawdown" | "portfolio" | "alerts">("calibration");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c, portfolios] = await Promise.all([
        fetch("/api/paper/stats").then((r) => r.json()),
        fetch("/api/paper/calibration").then((r) => r.json()),
        fetch("/api/paper/portfolio").then((r) => r.json()),
      ]);
      setStats(s);
      setCalibration(c);
      // Load first portfolio details if any exist
      const pList = Array.isArray(portfolios) ? portfolios : [];
      if (pList.length > 0) {
        const pd = await fetch(`/api/paper/portfolio?id=${pList[0].id}`).then((r) => r.json());
        setPortfolio(pd);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleRefreshCalibration() {
    setRefreshing(true);
    await fetch("/api/paper/calibration", { method: "POST" });
    const c = await fetch("/api/paper/calibration").then((r) => r.json());
    setCalibration(c);
    setRefreshing(false);
  }

  async function handleRunEngine() {
    setRefreshing(true);
    await fetch("/api/paper/stats", { method: "POST" });
    await load();
    setRefreshing(false);
  }

  const TABS = [
    { id: "calibration", label: "Confidence Calibration" },
    { id: "drawdown", label: "Drawdown Research" },
    { id: "portfolio", label: "Portfolio Simulation" },
    { id: "alerts", label: "Recent Alerts" },
  ] as const;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Paper Trading Research</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Simulated estimates only — not financial advice. Results exclude unknown execution costs.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRefreshCalibration}
              disabled={refreshing}
              className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50"
            >
              {refreshing ? "Working…" : "Refresh Calibration"}
            </button>
            <button
              onClick={handleRunEngine}
              disabled={refreshing}
              className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50"
            >
              Run Engine
            </button>
          </div>
        </div>

        {/* Signal universe summary */}
        {stats?.universe && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {[
              { label: "Total Sent Alerts", value: String(stats.universe.total_sent_alerts ?? 0) },
              { label: "With Observations", value: String(stats.universe.with_observations ?? 0) },
              { label: "Confidence 90+", value: String(stats.universe.band_90plus ?? 0) },
              { label: "Confidence 85–89", value: String(stats.universe.band_85_89 ?? 0) },
            ].map((s) => (
              <div key={s.label} className="bg-zinc-800/50 rounded p-3">
                <div className="text-xs text-zinc-400">{s.label}</div>
                <div className="text-2xl font-mono font-bold text-zinc-100">{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Tab nav */}
        <div className="flex gap-1 border-b border-zinc-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "text-zinc-100 border-b-2 border-blue-500"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="text-sm text-zinc-500 py-8 text-center">Loading…</div>
        )}

        {!loading && tab === "calibration" && calibration && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-400">Forward window:</span>
              {calibration.windows.map((w) => (
                <button
                  key={w}
                  onClick={() => setCalWindow(w)}
                  className={`px-2 py-1 text-xs rounded ${calWindow === w ? "bg-blue-700" : "bg-zinc-700 hover:bg-zinc-600"}`}
                >
                  {w < 60 ? `${w}m` : `${w / 60}h`}
                </button>
              ))}
            </div>
            <CalibrationTable data={calibration} windowMin={calWindow} />
          </div>
        )}

        {!loading && tab === "drawdown" && (
          <DrawdownSection
            summary={stats?.drawdownSummary ?? null}
            chart={stats?.drawdownChart ?? []}
          />
        )}

        {!loading && tab === "portfolio" && (
          <PortfolioSection data={portfolio} />
        )}

        {!loading && tab === "alerts" && (
          <RecentPerformance rows={stats?.recentPerformance ?? []} />
        )}
      </div>
    </div>
  );
}
