"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, X, Wallet2, Sliders, Play, Activity, Trash2, Power } from "lucide-react";
import { DatabaseExport } from "@/components/database-export";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestKeelRefresh, usePoll } from "@/components/use-poll";
import { fmtStamp, fmtTime } from "@/lib/format";

type Wallet = {
  address: string;
  label: string;
  enabled: boolean;
  lastIngestAt: string | null;
  lastPolledAt: string | null;
  events1h: number;
  events24h: number;
  dailyRate: number;
};

type Stats = {
  queue: Record<string, number>;
  pendingByType: Record<string, number>;
  tokens: Record<string, number>;
  lastIngestAt: string | null;
  providers: { provider: string; usedLastMinute: number; budgetPerMinute: number; last429At: string | null }[];
};

type SettingsTab = "wallets" | "pipeline";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [tab, setTab] = useState<SettingsTab>("wallets");
  const wallets = usePoll<{ wallets: Wallet[] }>("/api/wallets", 15_000, open);
  const stats = usePoll<Stats>("/api/pipeline/stats", 10_000, open && tab === "pipeline");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function mutate(url: string, init: RequestInit, key: string): Promise<boolean> {
    setBusy(key);
    setFormError(null);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Request failed");
      await Promise.all([wallets.reload(), stats.reload()]);
      requestKeelRefresh();
      return true;
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Request failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog text-ink"
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <div className="flex h-full max-h-[inherit] flex-col rounded-t-2xl md:rounded-2xl bg-paper-2 overflow-hidden border border-line/80 shadow-2xl backdrop-blur-md">
        {/* Mobile drag handle */}
        <div className="mx-auto mt-2 h-1 w-12 rounded-full bg-line/80 md:hidden" />

        <header className="settings-header">
          <div className="flex items-center gap-2">
            <Sliders className="size-4 text-teal" />
            <h2 id={titleId} className="text-sm font-mono font-bold uppercase tracking-wider text-ink">
              Settings
            </h2>
          </div>
          <div role="tablist" aria-label="Settings" className="ml-auto flex rounded-lg border border-line/80 bg-paper-2 p-0.5">
            {(
              [
                ["wallets", "Wallets", Wallet2],
                ["pipeline", "Pipeline", Activity],
              ] as const
            ).map(([id, text, Icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`flex items-center gap-1.5 h-8 rounded-md px-3 text-xs font-mono transition-all ${
                  tab === id
                    ? "bg-teal/15 text-teal font-semibold border border-teal/30"
                    : "text-muted hover:text-ink"
                }`}
                onClick={() => setTab(id)}
              >
                <Icon className="size-3.5" />
                {text}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-paper-3 transition-colors ml-1"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-paper/60">
          <DatabaseExport />
          {formError ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-mono text-loss">
              {formError}
            </div>
          ) : null}

          {tab === "wallets" ? (
            <section className="space-y-4">
              <div className="rounded-xl border border-line/70 bg-paper-2 p-3.5">
                <p className="text-xs font-mono text-muted/80 leading-relaxed">
                  Add Solana wallets as discovery sources. Keel evaluates tokens, not wallets. Enabled sources feed the monitoring pipeline.
                </p>
                <form
                  className="mt-3 flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate("/api/wallets", { method: "POST", body: JSON.stringify({ address, label }) }, "add").then((ok) => {
                      if (ok) {
                        setAddress("");
                        setLabel("");
                      }
                    });
                  }}
                >
                  <Input
                    aria-label="Wallet label"
                    placeholder="Source label (optional)"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    className="sm:w-44 text-xs font-mono bg-paper border-line"
                  />
                  <Input
                    aria-label="Wallet address"
                    placeholder="Solana wallet address"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    className="sm:min-w-0 sm:flex-1 text-xs font-mono bg-paper border-line"
                    required
                  />
                  <Button
                    type="submit"
                    disabled={busy === "add"}
                    className="min-h-[38px] text-xs font-mono bg-teal hover:bg-teal/90 text-paper font-bold shrink-0"
                  >
                    Add Wallet
                  </Button>
                </form>
              </div>

              <div className="space-y-2">
                <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted font-semibold px-1">
                  Discovery sources ({wallets.data?.wallets.length ?? 0})
                </h3>
                {wallets.loading && !wallets.data ? (
                  <p className="text-xs font-mono text-muted py-4 text-center">Loading discovery sources…</p>
                ) : null}
                {wallets.error ? <p className="text-xs font-mono text-loss">{wallets.error}</p> : null}
                <div className="grid gap-2">
                  {(wallets.data?.wallets ?? []).map((wallet) => (
                    <div
                      key={wallet.address}
                      className="rounded-xl border border-line/80 bg-paper-2 p-3 hover:border-line transition-all"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-bold text-ink">{wallet.label || "Untitled wallet"}</span>
                            <span
                              className={`size-1.5 rounded-full ${wallet.enabled ? "bg-emerald-400 animate-pulse" : "bg-neutral-600"}`}
                            />
                          </div>
                          <p className="truncate font-mono text-[11px] text-muted/70 mt-0.5 select-all">{wallet.address}</p>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase font-bold tracking-wider ${
                            wallet.enabled
                              ? "bg-emerald-500/10 text-teal border border-emerald-500/20"
                              : "bg-chip text-muted"
                          }`}
                        >
                          {wallet.enabled ? "Active" : "Paused"}
                        </span>
                      </div>
                      <p className="mt-2 text-[10px] font-mono text-muted/60">
                        {wallet.dailyRate.toLocaleString("en-US")} events/day · Last ingest {fmtStamp(wallet.lastIngestAt)} · Polled{" "}
                        {fmtStamp(wallet.lastPolledAt)}
                      </p>
                      <div className="mt-3 flex items-center justify-end gap-2 border-t border-line/50 pt-2.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px] font-mono border-line/80 hover:bg-paper-3"
                          onClick={() =>
                            void mutate(
                              `/api/wallets/${wallet.address}`,
                              { method: "PATCH", body: JSON.stringify({ enabled: !wallet.enabled }) },
                              wallet.address,
                            )
                          }
                        >
                          <Power className="size-3 mr-1" />
                          {wallet.enabled ? "Pause" : "Enable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          className="h-7 text-[11px] font-mono"
                          onClick={() => {
                            if (window.confirm(`Remove ${wallet.label || wallet.address}? History stays.`)) {
                              void mutate(`/api/wallets/${wallet.address}`, { method: "DELETE" }, wallet.address);
                            }
                          }}
                        >
                          <Trash2 className="size-3 mr-1" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : (
            <section className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs font-mono border-line/80 hover:bg-paper-3"
                  disabled={busy === "run"}
                  onClick={() => void mutate("/api/pipeline/run", { method: "POST" }, "run")}
                >
                  <Play className="size-3 text-teal mr-1.5" />
                  Process Queue
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs font-mono border-line/80 hover:bg-paper-3"
                  disabled={busy === "poll"}
                  onClick={() => void mutate("/api/pipeline/poll", { method: "POST" }, "poll")}
                >
                  <RefreshCw className="size-3 mr-1.5" />
                  Poll Wallets
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs font-mono border-line/80 hover:bg-paper-3"
                  disabled={busy === "gains"}
                  onClick={() => void mutate("/api/pipeline/gains", { method: "POST" }, "gains")}
                >
                  <Activity className="size-3 mr-1.5" />
                  Refresh Gains
                </Button>
              </div>

              {stats.error ? <p className="text-xs font-mono text-loss">{stats.error}</p> : null}

              <div className="space-y-2">
                <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted font-semibold px-1">
                  Provider Rate Limits
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(stats.data?.providers ?? []).map((provider) => {
                    const width = Math.min(100, (provider.usedLastMinute / Math.max(1, provider.budgetPerMinute)) * 100);
                    const isHigh = width > 80;
                    return (
                      <div key={provider.provider} className="rounded-xl border border-line/80 bg-paper-2 p-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-[11px] uppercase font-mono tracking-wider text-ink font-semibold">{provider.provider}</p>
                          <p className="tabular text-xs font-mono text-muted">
                            <span className="text-ink font-bold">{provider.usedLastMinute}</span> / {provider.budgetPerMinute} req/m
                          </p>
                        </div>
                        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-paper">
                          <div
                            className={`h-full transition-all duration-300 ${isHigh ? "bg-amber-400" : "bg-emerald-400"}`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <p className="mt-1.5 truncate text-[10px] text-muted/60 font-mono">
                          429 Status: {provider.last429At ? fmtTime(provider.last429At) : "nominal"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-line/70 bg-paper-2 p-3 font-mono text-xs">
                <p className="text-muted/80">
                  Queue pending <span className="text-ink font-bold">{stats.data?.queue.pending ?? 0}</span> · Running{" "}
                  <span className="text-teal font-bold">{stats.data?.queue.running ?? 0}</span> · Failed{" "}
                  <span className="text-loss font-bold">{stats.data?.queue.failed ?? 0}</span>
                </p>
                {stats.data?.pendingByType && Object.keys(stats.data.pendingByType).length > 0 ? (
                  <p className="mt-1.5 text-[10px] text-muted/60 border-t border-line/40 pt-1.5">
                    {Object.entries(stats.data.pendingByType)
                      .map(([type, count]) => `${type}: ${count}`)
                      .join(" · ")}
                  </p>
                ) : null}
              </div>
            </section>
          )}
        </div>
      </div>
    </dialog>
  );
}
