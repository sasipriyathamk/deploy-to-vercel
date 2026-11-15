# Telegram alerts and performance evidence

Keel's primary notification signal is **published confidence >=75**, including later threshold crossings. Score and AI verdict are background evidence, not independent notification gates. The existing confidence formula is unchanged. Watching and every other UI section remain unchanged.

## One token, one alert

`telegram_alerts.mint` is permanently unique. Every qualifying token gets one initial opportunity ledger record. Before the first confirmed delivery, new qualifying observations may refresh its pending snapshot so the message describes current evidence. Qualification history remains in `alert_observations`. The latest token and AI context is attached atomically when delivery is claimed, preserving the quoted baseline and quote timestamp; the outgoing snapshot then freezes for that attempt; after a confirmed send neither later confidence changes, archive/revival, nor additional evidence causes another initial opportunity alert. Gain milestones are separate, once-per-level notifications.

Every newly collected raw/parsed transaction, saved pipeline check and subsequent AI verdict is copied into the alert's observation stream, including the complete available token record, original check/event payload and flags, latest available AI output, and market snapshot where available. AI-only/context events have no invented price. Existing candidate `first_alert_at` is not Telegram delivery time and is not overwritten. Legacy `confidence_alerts` records are not assumed to be delivered Telegram messages.

An active candidate/watching token needs >=75 confidence and a usable price or market-cap quote recorded within five minutes to be sent. Threshold confirmation uses the published field, not its unconfirmed pending value. A queued token that weakens is held until a later qualifying observation. No low-cap, score or AI gate is added. Missing evidence is included as unknown. A fresh observation timestamp does not establish upstream quote freshness; market providers can use the existing 90-second cache.

## Delivery, speed and duplicates

Delivery is attempted after queue batches, refresh batches and awaited webhook follow-up, when at least nine seconds remain. Send requests have an eight-second timeout. The protected alert cron prioritises initial messages, then milestone notifications, before hourly work; it can deliver newly observed milestones after hourly work within the same budget. Detection speed still depends on wallet ingest and evaluation schedules; this is not a promise of instant detection or a new confidence model.

Telegram sendMessage has no idempotency key. The implementation chooses conservative duplicate prevention:

- One worker atomically changes a pending record to sending before making the request.
- A successful Telegram response records its message ID and confirmed `sent_at`.
- Explicit HTTP 429 rejection permits a delayed retry, while respecting quote freshness and eligibility.
- Explicit 4xx rejection is marked failed for configuration review.
- Network/parse errors, ambiguous responses and 5xx responses are unknown and never automatically retried. A crash after claiming leaves sending, also never automatically reclaimed. Sending older than two minutes appears in reconciliation stats.

A message might be delivered while its acknowledgement is lost. Such a record must be reconciled manually against Telegram before any retry. This sacrifices automatic recovery of some undelivered requests to avoid sending duplicates; it is not an exactly-once delivery guarantee. Do not reset sent, unknown or abandoned sending rows blindly. Unavailable Telegram credentials do not consume an attempt.

Telegram initial alerts show a compact emoji card: token name, confidence, price, market cap, liquidity and a GMGN link. Milestone cards show the level, actual sampled multiple/percentage, original alert baseline, observed market metrics, observation time and GMGN link. Missing metrics display a dash. Full token, trigger, market, reasons, safety, source and AI evidence remains in the authenticated ledger and observations; simplifying the message does not remove stored data. No credentials or private keys enter snapshots.

## After-alert observations and hourly review

In addition to every subsequent pipeline/AI observation, the alert worker samples **all confirmed sent tokens**, including archived tokens, on an hourly schedule anchored to `sent_at`. It does not stop when confidence falls. No fixed expiry is introduced. Provider budgets, bounded batches and execution deadlines still apply. A separate five-minute lease prevents concurrent hourly workers from claiming the same due record.

Each hourly capture stores its actual observation time and due target. Delayed runs take a current sample, record lateness, and advance to the next hour boundary. Failed captures retain a null-price evidence record and retry after lease expiry. Missed hours remain missing; the system never backfills historical prices with a current quote. Invoke the protected alert cron frequently enough and provision provider capacity for the number of sent tokens; hourly coverage is measured, not guaranteed.

The baseline is the immutable quoted price (or market cap if price was absent) supplied in the Telegram alert snapshot. `snapshot_at` and `sent_at` are both retained, exposing quote-to-delivery delay. Only observations at/after confirmed send time enter performance calculations, with the same basis throughout. Old system entry or current token gain fields are not substituted.

Stats distinguish current sampled return, minimum/maximum sampled return, and peak-to-trough drawdown from the running observed peak (including baseline). For example, 100 -> 120 -> 90 gives -10% return, -25% drawdown. Hourly groups contain actual observations, coverage counts and target lateness. Null/failed samples are excluded from price denominators, not scored as zero returns. Sparse sampling may miss true peaks and lows. No fees, slippage or executable-return claim is included.

## APIs

The evidence and worker APIs below use `Authorization: Bearer $CRON_SECRET` in production. They preserve existing app routes and UI.

- `GET /api/alerts?before=<id>`: confirmed sent alerts only, 50 at a time; >=75 at qualification, even if subsequent confidence drops. Returns `nextBefore`.
- `GET /api/alerts/:id?after=<observation-id>`: immutable sent alert, full follow-up evidence (200 per page), performance and hourly groups. Returns `nextAfter`.
- `GET /api/alerts/stats`: delivery-state counts, outcomes with explicit coverage, hourly backlog and stalled sending count. No claim of calibrated accuracy.
- `GET /api/cron/alerts`: protected delivery/hourly worker, 45-second budget, up to thirty initial/milestone send attempts combined and up to thirty due hourly observations as time permits. Delivery alternates notification kinds and paces requests for the configured chat. A reserved observation budget prevents a discovery backlog from starving hourly review. Newly captured milestones can use the remaining send quota/time in that run.

With the feature disabled these protected endpoints return `enabled:false` without querying alert tables. Existing routes retain their behavior.

## Activation requires separate review

Code is **off by default**. Do not enable against production until migration compatibility, historical delivery deduplication and secure configuration are reviewed. This checkout still lacks some legacy production migration files; `0008_telegram_alerts.sql` creates separate tables and does not rewrite legacy alerts. Applying a new migration or deploying to production requires explicit approval.

After that review:

1. Review `0008_telegram_alerts.sql` and `0009_telegram_milestones.sql` against a safe database copy. Set `ALLOW_ALERT_MIGRATIONS=1` only for their approved application through the normal migration process, keeping `TELEGRAM_ALERTS_ENABLED=0`. With that migration flag unset, both build-time and application-startup migration runners skip these two files. Return the migration flag to `0` afterward.
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `CRON_SECRET` securely, while leaving `TELEGRAM_ALERTS_ENABLED=0`. Never paste values into chat or commit them. Verify HTTPS access to `api.telegram.org` and the bot/chat configuration before enabling delivery.
3. Configure the existing external scheduler to call `/api/cron/alerts` every minute with the bearer header and a 60-second timeout. Do not add minute-level cron to Vercel Hobby's daily-only config. The worker must run independently of a browser being open.
4. First validate transport with a mock/test bot and isolated database. Sending a real test message needs explicit authorization. Enabling live operation may qualify existing fresh >=75 tokens when they next receive a recorded observation; no historical delivery state is guessed.
5. Only after live activation is explicitly approved, set `TELEGRAM_ALERTS_ENABLED=1`. Monitor pending/stale eligibility, unknown/stalled delivery, actual hourly coverage, missing prices, drawdown and send latency. Reconcile uncertain outcomes before retrying anything.

No live Telegram send, production migration, scheduler change or deployment is performed merely by adding this code. Full snapshot storage grows with observations; retention/storage sizing needs an explicit future policy rather than silently deleting evidence.


## Gain milestone notifications

The configured milestones are **2×, 3×, 5× and 10×** the original alert's immutable quote baseline: respectively +100%, +200%, +400% and +900%. No drawdown warnings are sent. Initial opportunity alerts remain one per token; each milestone can separately produce one notification for that same token. A confidence decline or archive does not reset or suppress already-alerted tokens' milestone tracking.

Detection runs atomically with each actual, post-send, priced observation, using the parent's original price/market-cap basis. Context-only, missing, pre-send and future samples do not trigger milestones. A jump to 6.5× records 2×, 3× and 5× against that same actual 6.5× observation; it does not invent intermediate prices or crossing times. The first observed snapshot, elapsed time, source observation ID and actual value are preserved. A unique `(alert_id,multiple)` prevents repeated crossings, concurrent workers and later revival from creating duplicates. Sampled data can miss real intrahour crossings.

Milestones use the same conservative delivery state machine as initial messages: confirmed delivery saves a Telegram message ID, explicit 429 rejection waits for retry-after, and ambiguous sends are never retried automatically. An explicit rate-limit backoff blocks both notification types for the configured chat. If the bot was offline, a delayed message describes its historical observed timestamp, not a claim about the current price. Uncertain delivery must be reconciled before any manual retry.

`GET /api/alerts/:id` includes its milestone evidence and delivery states. `GET /api/alerts/stats` includes all four levels, initial sent-alert denominators, distinct observed reaches, sent/pending/sending/unknown/failed milestone notifications, observed reach percentages and median seconds to first observed reach. Observed reach is separate from Telegram acknowledgement and from initial alert counts; it is not a calibrated hit rate or executable profit. No UI sections are removed or replaced.


## Alert stats in the workspace

The **Alert stats** navigation entry adds a responsive dashboard without removing Watching, Candidates or Archive. It refreshes every 10 seconds and separates confirmed Telegram acknowledgements, queued deliveries and attempts needing review. Current confidence-75+ token counts are reference counts, not delivery totals.

Performance uses the original alert baseline and actual post-send observations. Missing follow-up quotes remain unavailable. The dashboard shows sampled return, peak-to-trough drawdown, priced coverage, the latest twenty sent alerts, and each 2×/3×/5×/10× milestone's observed reach separately from confirmed notification delivery. Token links open the existing reference page, whose original tracking baseline may differ.

`GET /api/alerts/summary` is a read-only, unauthenticated projection for the existing public research UI, like the token listing. It exposes aggregate counts, recent token references, sampled outcomes, configuration booleans and worker activity timestamps. It never returns credential values, chat IDs, Telegram message IDs, delivery error text or full evidence snapshots. Full evidence remains behind the protected APIs above. This summary remains available when delivery is disabled so existing outcomes and configuration gaps can still be inspected. Missing alert tables produce unavailable totals rather than invented zeros.

After deploying this dashboard version, enabled alert-worker invocations record start/finish activity in the existing `pipeline_runs` table. Activity is not proof of a successful send or guaranteed hourly coverage; confirmed acknowledgements and observation coverage remain separate. Earlier deployments did not record this activity, so an absent timestamp alone does not establish that the scheduler never ran. No additional migration is needed for this UI.


## Backlog recovery and continuous operation

The alert worker runs independently of the discovery drain lease. It refreshes up to thirty stale queued opportunities in one DexScreener batch, recomputes published confidence through the normal refresh path, and persists that quote as a market check before claiming delivery. Ineligible tokens wait; stale evidence is never sent as a fresh baseline. Milestones receive alternating delivery turns during discovery bursts. Explicit Telegram backoff and uncertain-delivery reconciliation remain in force. Observations and missing data remain durable.

Configure a frequent external scheduler for `/api/cron/alerts`, or run `npm run alerts:worker` on an always-on Node host with `KEEL_APP_URL` and `CRON_SECRET` set securely. The supplied loop waits for each request to finish, then waits five seconds before calling again. It does not overlap its own requests. No scheduler is provisioned merely by merging this PR, and the Vercel Hobby daily cron configuration cannot provide continuous operation. The alert worker does not depend on an open browser. Zero pending messages or zero latency cannot be guaranteed during provider failures, Telegram throttling or bursts; the UI reports real queue totals, including records needing fresh evidence.

DexScreener is the primary complete market snapshot. Jupiter supplies a standalone fallback only when Dex has no usable price or market cap, without overwriting a valid Dex quote or borrowing its metrics. Cache hits retain their provider retrieval timestamp. Hourly provider requests are batched and require retrieval after the due target. Hourly captures use the same persisted market-check path as token listings and alert observations. Failed samples preserve missing evidence and do not manufacture hourly prices. Initial and follow-up alert snapshots retain their original values and fixed baseline.
