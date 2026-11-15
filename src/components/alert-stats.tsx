"use client";
import Link from "next/link";
import {
  RefreshCw,
  CheckCircle2,
  CircleDashed,
  ArrowUpRight,
  BellRing,
  ShieldAlert,
} from "lucide-react";
import { usePoll } from "@/components/use-poll";
import { signedPct, fmtTime } from "@/lib/format";
import type { AlertSummary } from "@/lib/alerts/summary";
export function AlertStatsDashboard() {
  const { data, error, loading, reload } = usePoll<AlertSummary>(
    "/api/alerts/summary",
    10000,
  );
  return (
    <div className="alert-stats-page">
      <div className="page-eyebrow">
        <span>Refreshes every 10s</span>
      </div>
      <div className="section-heading">
        <div>
          <h1>Alert performance</h1>
        </div>
        <button
          className="outline-control"
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />{" "}
          Refresh
        </button>
      </div>
      {error && (
        <div className="notice error" role="alert">
          Couldn’t refresh alert statistics.{" "}
          {data ? "Showing the last received data." : "Please try again."}
          <button onClick={() => void reload()}>Retry</button>
        </div>
      )}
      {!data ? (
        <div className="loading-state" role="status">
          <BellRing size={25} />
          <h2>{error ? "Statistics unavailable" : "Loading alert evidence"}</h2>
          <p>
            No delivery or outcome counts are assumed while data is unavailable.
          </p>
        </div>
      ) : (
        <StatsContent data={data} />
      )}
    </div>
  );
}
function StatsContent({ data: d }: { data: AlertSummary }) {
  const c = d.configuration;
  const ready =
    c.enabled &&
    c.botConfigured &&
    c.chatConfigured &&
    c.workerSecretConfigured &&
    c.schemaReady;
  const review = d.delivery
    ? d.delivery.unknown + d.delivery.failed + (d.stalledSending ?? 0)
    : null;
  const checks = [
    {
      label: "Alert storage",
      ok: c.schemaReady,
      hint: "Reviewed migrations 0008 and 0009",
    },
    {
      label: "Delivery enabled",
      ok: c.enabled,
      hint: "TELEGRAM_ALERTS_ENABLED=1",
    },
    {
      label: "Bot token configured",
      ok: c.botConfigured,
      hint: "TELEGRAM_BOT_TOKEN (not a numeric bot ID)",
    },
    {
      label: "Destination configured",
      ok: c.chatConfigured,
      hint: "TELEGRAM_CHAT_ID",
    },
    {
      label: "Worker protected",
      ok: c.workerSecretConfigured,
      hint: "CRON_SECRET",
    },
  ];
  return (
    <>
      <details className="alert-configuration" open={!ready}>
      <summary>Telegram configuration</summary>
      <section
        className={`alert-readiness ${ready ? "configured" : ""}`}
        aria-label="Telegram setup status"
      >
        <div>
          <ShieldAlert size={22} />
          <div>
            <h2>
              {ready
                ? "Configuration ready — verify delivery below"
                : "Telegram setup needs attention"}
            </h2>
            <p>
              {!c.schemaReady
                ? "Alert storage is not installed. Qualifying tokens cannot create Telegram alerts yet."
                : !c.enabled
                  ? "Alert delivery is paused. Confidence readings alone do not send Telegram messages."
                  : !c.botConfigured || !c.chatConfigured
                    ? "The deployed server is missing Telegram credentials or a destination."
                    : "Configuration checks do not prove that Telegram accepted a message or that the scheduler is running."}
            </p>
          </div>
        </div>
        <div className="alert-setup-grid">
          {checks.map((s) => (
            <div key={s.label} className={s.ok ? "complete" : "incomplete"}>
              {s.ok ? <CheckCircle2 size={17} /> : <CircleDashed size={17} />}
              <span>
                <strong>{s.label}</strong>
                <small>{s.ok ? "Configured" : s.hint}</small>
              </span>
            </div>
          ))}
        </div>
        <details className="plain-details">
          <summary>Setup and activation requirements</summary>
          <p className="subtle-copy">
            Store the bot token, chat ID and worker secret in Vercel’s server
            environment variables, never in browser code. Changes require a new
            deployment. Apply the reviewed alert migrations with
            ALLOW_ALERT_MIGRATIONS=1, then return it to 0. Enable delivery only
            after configuration is verified. Configure /api/cron/alerts every
            minute with the bearer secret; this worker also captures hourly
            snapshots. This page never enables sending or runs migrations.
          </p>
        </details>
      </section>
      </details>
      <section className="alert-kpis" aria-label="Delivery totals">
        <Kpi
          label="Initial alerts delivered"
          value={d.delivery?.sent}
          note="Confirmed Telegram acknowledgement"
        />
        <Kpi
          label="Awaiting delivery"
          value={
            d.delivery ? d.delivery.pending + d.delivery.waiting : undefined
          }
          note={d.queuedStale == null ? "Queued or waiting for fresh evidence" : `${d.queuedFresh ?? 0} fresh · ${d.queuedStale} need new quotes · ${d.delivery?.waiting ?? 0} waiting`}
        />
        <Kpi
          label="Needs review"
          value={review ?? undefined}
          note="Rejected, uncertain or stalled sends"
        />
        <Kpi
          label="Confidence 75+ tokens"
          value={d.qualifyingTokens}
          note="Current active book, not delivery count"
        />
      </section>
      <div className="alert-section-title">
        <div>
          <p className="eyebrow">AFTER THE INITIAL ALERT</p>
          <h2>Performance, with the gaps visible.</h2>
        </div>
        <span className="count-pill">Original alert baseline</span>
      </div>
      <section
        className="alert-kpis outcomes"
        aria-label="Alert outcome statistics"
      >
        <Kpi
          label="Mean latest sampled return"
          value={d.performance?.meanReturn}
          percent
          note="Excludes alerts without priced follow-up"
        />
        <Kpi
          label="Worst sampled drawdown"
          value={d.performance?.worstDrawdown}
          percent
          note="Peak-to-trough, including the baseline"
        />
        <Kpi
          label="Priced follow-up coverage"
          value={
            d.performance
              ? `${d.performance.covered} / ${d.delivery?.sent ?? 0}`
              : undefined
          }
          note="Alerts with at least one post-send quote"
        />
        <Kpi
          label="Currently above baseline"
          value={d.performance?.aboveBaseline}
          note="A sampled outcome, not a predicted win rate"
        />
      </section>
      <section className="research-panel alert-milestones-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">2× / 3× / 5× / 10×</p>
            <h2>Milestone reach & delivery</h2>
          </div>
          <BellRing size={22} />
        </div>
        <p className="subtle-copy">
          Observed reaches and Telegram acknowledgements are counted separately.
          Each level notifies once per token, even after dips and recrossings.
        </p>
        <div className="alert-milestone-grid">
          {[2, 3, 5, 10].map((level) => {
            const m = d.milestones.find((x) => x.multiple === level);
            return (
              <article key={level}>
                <div className="milestone-level">
                  <strong>{level}×</strong>
                  <span>+{(level - 1) * 100}% vs alert</span>
                </div>
                <dl>
                  <div>
                    <dt>Observed reaching</dt>
                    <dd>{m?.reached ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Telegram delivered</dt>
                    <dd>{m?.sent ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Pending / sending</dt>
                    <dd>{m?.pending ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Needs review</dt>
                    <dd>{m?.review ?? "—"}</dd>
                  </div>
                </dl>
                <p>
                  Median first observed reach{" "}
                  <strong>
                    {m?.medianSeconds == null
                      ? "—"
                      : `${(m.medianSeconds / 3600).toFixed(1)}h`}
                  </strong>
                </p>
              </article>
            );
          })}
        </div>
      </section>
      <section className="research-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">LATEST 20 CONFIRMED INITIAL ALERTS</p>
            <h2>Signal outcomes</h2>
          </div>
          <span className="count-pill">{d.recent.length}</span>
        </div>
        <p className="subtle-copy">
          Returns use the quoted Telegram alert baseline. Token links open the
          existing reference page, whose general token gain may use a different
          baseline.
        </p>
        {!d.recent.length ? (
          <div className="alert-no-deliveries">
            <BellRing size={25} />
            <h3>
              {c.schemaReady
                ? "No confirmed initial alerts yet"
                : "Alert records unavailable until storage is ready"}
            </h3>
            <p>
              Passing pipeline checks or displaying confidence does not
              establish Telegram delivery. A message counts here only after
              Telegram acknowledges it.
            </p>
          </div>
        ) : (
          <div className="alert-outcomes-list">
            {d.recent.map((a) => (
              <article key={a.id}>
                <div className="alert-outcome-token">
                  <Link href={`/tokens/${a.mint}`}>
                    {a.symbol}
                    <ArrowUpRight size={14} />
                  </Link>
                  <small>
                    {fmtTime(a.sentAt)} · confidence {a.confidence}
                  </small>
                  <span>
                    Alert #{a.id} · {a.basis} baseline
                  </span>
                </div>
                <div>
                  <span>Latest sampled return</span>
                  <strong
                    className={
                      a.latestReturn != null && a.latestReturn < 0
                        ? "negative"
                        : "positive"
                    }
                  >
                    {signedPct(a.latestReturn)}
                  </strong>
                  <small>{a.pricedObservations} priced observations</small>
                </div>
                <div>
                  <span>Sampled drawdown</span>
                  <strong
                    className={
                      a.drawdown != null && a.drawdown < 0 ? "negative" : ""
                    }
                  >
                    {signedPct(a.drawdown)}
                  </strong>
                  <small>
                    {a.milestones.length
                      ? a.milestones.map((m) => `${m}×`).join(" · ")
                      : "No milestones observed"}
                  </small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <div className="alert-operations-grid">
        <section className="research-panel">
          <p className="eyebrow">WORKER & HOURLY COVERAGE</p>
          <h2>Is monitoring running?</h2>
          <dl className="alert-operations">
            <div>
              <dt>Last alert worker activity</dt>
              <dd>
                {d.lastWorkerAt ? fmtTime(d.lastWorkerAt) : "Not recorded yet"}
              </dd>
            </div>
            <div>
              <dt>Last confirmed initial delivery</dt>
              <dd>{d.lastSentAt ? fmtTime(d.lastSentAt) : "None recorded"}</dd>
            </div>
            <div>
              <dt>Hourly observations due</dt>
              <dd>{d.hourlyDue ?? "—"}</dd>
            </div>
            <div>
              <dt>Stalled initial sends</dt>
              <dd>{d.stalledSending ?? "—"}</dd>
            </div>
          </dl>
          <p className="subtle-copy">
            Worker activity is not proof of successful delivery. Hourly samples
            can be late or missing; the system does not fabricate prices for
            missed hours.
          </p>
        </section>
        <section className="research-panel">
          <p className="eyebrow">DELIVERY STATES</p>
          <h2>Count only what is confirmed.</h2>
          <dl className="alert-operations">
            {[
              ["pending", "Queued"],
              ["waiting", "Waiting for eligible evidence"],
              ["sending", "Request in progress"],
              ["unknown", "Uncertain — reconcile manually"],
              ["failed", "Rejected — review configuration"],
            ].map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{d.delivery?.[key] ?? "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="subtle-copy">
            Uncertain messages are not automatically resent. This avoids
            duplicate alerts when an acknowledgement is lost.
          </p>
        </section>
      </div>
      <p className="alert-methodology">
        Observed snapshots only. Missing follow-ups remain unknown. Fees,
        slippage and execution latency are excluded; these are research
        measurements, not executable returns. Full evidence and delivery details
        remain behind the authenticated alert APIs.
      </p>
    </>
  );
}
function Kpi({
  label,
  value,
  note,
  percent = false,
}: {
  label: string;
  value?: number | string | null;
  note: string;
  percent?: boolean;
}) {
  const empty = value == null;
  return (
    <article>
      <p>{label}</p>
      <strong
        className={
          percent && typeof value === "number"
            ? value < 0
              ? "negative"
              : "positive"
            : ""
        }
      >
        {empty
          ? "—"
          : percent && typeof value === "number"
            ? signedPct(value)
            : value}
      </strong>
      <small>{note}</small>
    </article>
  );
}
