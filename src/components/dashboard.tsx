"use client";
import { AlertStatsDashboard } from "@/components/alert-stats";
import { useEffect } from "react";
import { RefreshCw, Radio } from "lucide-react";
import { TrendingRail } from "@/components/trending-rail";
import { TokenBook } from "@/components/token-book";
import { usePoll } from "@/components/use-poll";
import { useNav } from "@/components/nav-context";
import type { TokenDto } from "@/lib/present";

export function Dashboard() {
  const { activeTab } = useNav();
  return activeTab === "alerts" ? <AlertStatsDashboard/> : <Workspace />;
}
function Workspace() {
  const { setTabCounts } = useNav();
  const status = "watching";
  const book = usePoll<{ tokens: TokenDto[]; gainers:TokenDto[]; volume:TokenDto[]; total:number }>(
    `/api/tokens?status=${status}&limit=200&order=latest&overview=1`,
    15000,
  );
  useEffect(() => {
    // Periodically trigger a live gains refresh while the tab is active
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        fetch("/api/pipeline/gains", { method: "POST" }).catch(() => {});
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setTabCounts({
      watching: book.data?.total,
    });
  }, [setTabCounts, book.data]);
  const tokens = book.data?.tokens ?? [];
  const total = book.data?.total;
  return (
    <div className="workspace">
      <div className="page-eyebrow">
        <span className="connection-state">
          <Radio size={13} />
          {book.error
            ? "Connection interrupted"
            : book.data
              ? "Refreshes every 15s"
              : "Connecting"}
        </span>
      </div>
      <TrendingRail gainers={book.data?.gainers ?? []} volume={book.data?.volume ?? []} loading={book.loading}/>
      <div className="section-heading">
        <div>

          <h2>
            Watching
            <span className="count-pill">{total ?? "—"}</span>
          </h2>
        </div>
        <button
          className="outline-control"
          disabled={book.loading}
          onClick={async () => {
            fetch("/api/pipeline/gains", { method: "POST" }).catch(() => {});
            await book.reload();
          }}
        >
          <RefreshCw size={15} className={book.loading ? "animate-spin" : ""} />{" "}
          Refresh
        </button>
      </div>
      {book.error && (
        <div className="notice error" role="alert">
          <strong>Couldn’t refresh this view.</strong> {book.error}{" "}
          {book.data
            ? "Showing the last received observations."
            : "Try refreshing again."}
          <button onClick={() => void book.reload()}>Retry</button>
        </div>
      )}
      {book.loading && !book.data ? (
        <div className="loading-state" role="status">
          <RefreshCw className="animate-spin" size={24} />
          <h3>Loading market observations</h3>
          <p>Gathering the latest available token records.</p>
        </div>
      ) : (
        <TokenBook tokens={tokens} />
      )}
      <div className="workspace-footnote">
        <span>
          {book.data
            ? `Showing ${tokens.length}${total != null ? ` of ${total}` : ""} tokens · sorting and filters apply to this loaded view.`
            : ""}
        </span>
      </div>
    </div>
  );
}
