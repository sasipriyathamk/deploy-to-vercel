# Keel

Keel watches Solana sniper wallets, keeps the memecoins that are not obvious junk, and measures gain from **your** entry. That entry is the price and market cap at the moment a token first becomes `watching`. It is not the sniper’s buy, and it is not the first price we happened to see.

This is a personal tracker. It does not trade, sign transactions, or hold private keys.

**Not financial advice.** The filters are intentionally lenient and will let rugs through. Archive is how dead coins leave, not an early hard reject.

## Telegram alerts and performance

The primary alert workflow selects published confidence **>=75**, sends one initial Telegram alert per token plus once-per-level 2×/3×/5×/10× gain milestones, preserves the available trigger evidence, and retains subsequent raw/parsed transactions, checks, AI updates and hourly market snapshots. Alert returns and peak-to-trough drawdown use the quoted Telegram baseline, independently of the legacy token gain fields. Existing UI sections remain available for reference.

Delivery and the two new alert schema migrations are opt-in (`TELEGRAM_ALERTS_ENABLED` and `ALLOW_ALERT_MIGRATIONS`). This feature is off by default. See [Telegram alerts and performance evidence](docs/telegram-alerts.md) for protected APIs, duplicate handling, coverage limitations and activation requirements. Production migration/deployment, secure bot/chat configuration and a frequent external scheduler require separate review; adding this code does not activate Telegram.

## Run locally

```bash
npm install
npm run dev
```

Open the printed localhost URL. With no `DATABASE_URL`, Keel uses embedded Postgres in `.data/pglite` so you can click around immediately. Production on Vercel needs a real Postgres URL. SQLite is not used, because it does not persist on serverless.

```bash
npm test
npm run build
```

`npm run build` applies SQL migrations when `DATABASE_URL` is set, then builds Next.js. You can also migrate by itself:

```bash
npm run db:migrate
```

The seed migration enables this wallet:

`STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk`

It is very active (on the order of 10k transactions a day, many of them failed, often pump.fun). Ingest is built for that volume: signature dedupe, coalesced jobs per mint, batched market calls, and backoff on HTTP 429.

## Deploy on Vercel

1. Create a Postgres database (Neon, Vercel Postgres, or any host that gives you a connection string).
2. Set the environment variables below.
3. Deploy. The build command is `npm run build`, which runs `node db/migrate.mjs` before `next build`.
4. Confirm the schedules below call `/api/cron/*` with `Authorization: Bearer $CRON_SECRET`.

Hobby allows each Vercel cron at most once a day. `vercel.json` keeps that daily fallback and is not the around-the-clock schedule. cron-job.org calls the same routes: poll every 10 minutes, recheck and gains every 15 minutes (offset from each other), and archive four times a day. Each request sends `Authorization: Bearer $CRON_SECRET` and uses a 60 second timeout. Poll, gains, and archive stop the drain around 45 seconds. Recheck stops the queue around 35 seconds, then runs at most two shadow verdicts with the time left inside a 50 second deadline, so the 60 second cron timeout is not hit.

GitHub Actions (`.github/workflows/pipeline-schedule.yml`) targets the same routes, but scheduled runs currently fail to start (`startup_failure`, likely Actions billing). The workflow file stays for `workflow_dispatch` and in case billing is restored. Do not put `*/5` or hourly crons in `vercel.json`. That deploy fails with `cron_jobs_limits_reached`.

| Path | cron-job.org | Daily Hobby fallback | Dashboard action |
| --- | --- | --- | --- |
| `GET /api/cron/poll` | every 10 min, UTC minutes 02/12/22/32/42/52 (IST minutes 32/42/52/02/12/22) | 03:30 UTC / 09:00 IST | Poll wallets, then drain the queue |
| `GET /api/cron/recheck` | every 15 min, UTC minutes 05/20/35/50 (IST minutes 35/50/05/20) | 04:00 UTC / 09:30 IST | Process queue (due T0 / T5 / T15 / T60 jobs) |
| `GET /api/cron/gains` | every 15 min, UTC minutes 10/25/40/55 (IST minutes 40/55/10/25) | 04:30 UTC / 10:00 IST | Refresh gains |
| `GET /api/cron/archive` | 00:17, 06:17, 12:17, 18:17 UTC (05:47, 11:47, 17:47, 23:47 IST) | 05:00 UTC / 10:30 IST | Archive thin markets and revive liquid ones |

cron-job.org is what actually calls these routes around the clock. The GitHub Actions schedule is still in the repo, but it currently fails to start. `workflow_dispatch` can run one route by hand. Per-token Archive and Revive stay manual.

Repository Actions secrets: `CRON_SECRET` (required), `APP_URL` (optional; defaults to `https://sniper-wallet-tracker.vercel.app`), and `VERCEL_AUTOMATION_BYPASS_SECRET` (optional). The bypass header is sent only when that secret is set. The production alias currently reaches the app, which returns JSON 401 without the bearer token. Preview deployment URLs redirect to Vercel SSO. Cron routes reject requests in production when `CRON_SECRET` is missing or wrong.

## Environment

Copy `.env.example`. Never commit real values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Production | Postgres connection string |
| `DATABASE_CA_CERT` | No | PEM CA if the host needs a custom certificate |
| `HELIUS_API_KEY` | No | Free Helius key. Webhooks are the preferred ingest path. When set, the RPC fallback uses Helius instead of the public mainnet endpoint |
| `HELIUS_WEBHOOK_SECRET` | No | If set, `POST /api/webhooks/helius` requires `Authorization: Bearer <secret>` |
| `JUPITER_API_KEY` | No | Free Jupiter portal key. Without it, price calls stay at the keyless budget |
| `PUBLIC_RPC_URL` | No | Default `https://api.mainnet-beta.solana.com` |
| `CRON_SECRET` | Production | Authorizes `/api/cron/*` |
| `OMO_AI_GATEWAY_URL` | No | OpenAI-compatible base URL for the shadow thesis verdict |
| `OMO_MODEL_API_KEY` | No | Gateway key sent as a bearer token and `Lovable-API-Key` |
| `FOMO_PRIVY_REFRESH_TOKEN` | No | Privy refresh token for the fomo.family thesis feed |
| `AI_VERDICT_MODEL` | No | Default `google/gemini-2.5-flash`. Unsupported ids fall back to `google/gemini-3.6-flash` |
| `AI_VERDICT_DAILY_CAP` | No | Model calls per IST day. Default `60` |

There is no login in v1. Do not expose the deployment on the public internet unless you add a password in front of it.

### Shadow AI verdict

The recheck cron (`GET /api/cron/recheck`, every 15 minutes from cron-job.org) drains the priority queue first, then judges candidates in the background with whatever time is left inside a 50 second deadline. A token is judged once when it first becomes a candidate, then only after a 30 minute gap and a material change: price (or mcap, when price is missing) moves at least 30% since the last real verdict, the FOMO thesis set changes, or the funnel stage changes. Each recheck stores at most two verdicts. Each model attempt is capped at 15 seconds and by the time still left. Raw buys are never sent to the model. The verdict does not change score, confidence, stage, archive, or hysteresis.

The result is stored in `ai_verdicts` (latest row plus history) and shown on candidate cards as **AI (shadow)**. It does not change score, confidence, stage, archive, or hysteresis. `GET /api/pipeline/ai-verdicts` compares strong, ok, and avoid buckets with current gain and ATH gain since the first-alert stamp.

If the gateway, FOMO session, or model call fails, that candidate is marked unavailable with a reason and the rest of the pipeline continues. Empty thesis feeds are still judged from the market snapshot.

### Free Helius key

1. Create an account at [dashboard.helius.dev](https://dashboard.helius.dev/).
2. Copy the API key into `HELIUS_API_KEY`.
3. Create one enhanced webhook. Set the URL to `https://<your-app>/api/webhooks/helius`.
4. Add every enabled wallet address (the seed wallet is the one to start with).
5. If you set `HELIUS_WEBHOOK_SECRET`, configure the webhook auth header as `Authorization: Bearer <that secret>`.

Helius free tier is about 1M credits/month, 10 RPC requests/second, and 5 webhooks. A webhook delivery is 1 credit. At ~10k events/day that is ~300k credits/month, which fits if you parse the webhook payload and only call RPC when the mint or side is missing.

### Free Jupiter key

1. Open [developers.jup.ag/portal](https://developers.jup.ag/portal).
2. Create a free key and set `JUPITER_API_KEY`.
3. Keel sends it as `x-api-key` to `https://api.jup.ag/price/v3`.

Keyless access is about 0.5 requests/second. A free key raises the in-app budget. Keel never calls a paid Jupiter tier.

## Free API budget

Primary market data is DexScreener, in batches of 30. Jupiter refreshes USD price, up to 50 mints per call. RugCheck is a score ingredient, not a gate, and only runs after a token survives T0. GeckoTerminal is a rare fallback when DexScreener has no pair.

| Source | Used for | Free limit Keel stays inside |
| --- | --- | --- |
| Helius | Webhook ingest, optional RPC | 1M credits/month, RPC 10 rps, 5 webhooks |
| Public Solana RPC | Signature poll if Helius RPC is unset | Kept to about 20 calls/minute. Null or 429 responses are retried later, never tight-looped |
| DexScreener | Liquidity, volume, transactions, market cap, pair age | App cap 200 requests/minute (their pair group is 300/minute). Batches of 30 mints |
| Jupiter Price v3 | USD price | Keyless cap 20/minute in-app (about 0.4 rps). With a free key, 120/minute. 50 ids max |
| RugCheck | Mint/freeze, risks, normalised score | About 50/minute and at least 1.1s between calls. Cached for 2 hours |
| GeckoTerminal | Fallback token price and reserves | 5 calls/minute. Cached. CoinGecko / GeckoTerminal attribution is required by their terms; this app credits them in the footer |

Responses are cached in memory and in Postgres (about 90 seconds for Dex and Jupiter).

## What the funnel does

Hard-drop only obvious junk:

- Mint is on the editable denylist in `src/lib/logic/junk.ts`
- Mint is SOL, wrapped SOL, or a stable
- DexScreener still has zero pairs after one retry about two minutes later

Everything else becomes a candidate. About five minutes out, liquidity, buy counts, and market-cap band are recorded as soft signals. They do not reject the token. About fifteen minutes out, the token is promoted to `watching` if **any two** of these hold: liquidity at least $3k, hourly volume at least $5k or 5-minute volume rising since T5, at least 10 buys in five minutes, and price not already down 95% from first seen.

The first transition to `watching` writes `entry_at`, `entry_price_usd`, and `entry_mcap_usd`. Later updates, including revive, do not change them. The database update itself refuses to overwrite a non-null `entry_at`.

Gain is `(current - entry) / entry * 100`. If price is missing but both market caps exist, the same formula runs on market cap and the UI labels it mcap gain. ATH gain uses the highest price since `entry_at` only.

Score starts at 50. Liquidity, volume, buy pressure, holders, authorities, RugCheck, whether the sniper still holds, age, venue, and drawdown are added or subtracted, then clamped to 0–100. There is no score cutoff for staying in watching. 60 and above is marked interesting.

Archive keeps the row. A token archives when it is lifeless around the one-hour check, thin for two hours (liquidity and hourly volume under $300), or down 90% for six hours with no buy pressure. You can archive by hand. Revive puts it back on `watching`, increments `revive_count`, and leaves the original entry in place. Raw events older than 14 days are pruned so a 10k-event day does not fill a free database.

## HTTP API

- `GET/POST /api/wallets`
- `PATCH/DELETE /api/wallets/:address`
- `POST /api/webhooks/helius` — stores the payload, enqueues parse jobs, responds, then drains a few jobs after the response
- `GET /api/tokens?status=watching|candidate|archived`
- `GET /api/tokens/:mint`
- `POST /api/tokens/:mint/archive` and `POST /api/tokens/:mint/revive`
- `GET /api/search?q=` — the UI waits 400ms, aborts the previous request, and limits to 50 rows
- `GET /api/feed`
- `GET /api/pipeline/stats`
- `POST /api/pipeline/run|poll|gains|archive` — the dashboard buttons. Cron routes do the same work.
- `GET /api/cron/poll|recheck|gains|archive` — `Authorization: Bearer $CRON_SECRET`. cron-job.org calls these around the clock. Vercel Cron calls each one once a day. GitHub Actions schedules currently fail to start.

A local webhook check:

```bash
curl -s -X POST http://127.0.0.1:43123/api/webhooks/helius \
  -H 'content-type: application/json' \
  -d '[{"signature":"example","feePayer":"STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk","source":"PUMP_FUN","timestamp":1700000000,"instructions":[{"programId":"6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}],"accountData":[{"account":"STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk","nativeBalanceChange":-500000000,"tokenBalanceChanges":[{"mint":"YOUR_MINT","userAccount":"STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk","rawTokenAmount":{"tokenAmount":"1000000","decimals":6}}]}]}]'
```

Replace `YOUR_MINT` with a real mint if you want T0 to find a DexScreener pair. Then click Process queue.

## Refresh coverage and freshness

After processing discovery jobs, each poll/gains/archive drain can refresh up to 200 watching tokens, oldest checked first, in batches of 30. Each batch is saved before fetching the next. Existing provider quotas and backoff still apply; the run stops admitting provider requests with less than 12 seconds of deadline headroom. Jupiter failures do not discard available DexScreener data. Empty market responses do not count as successful refreshes. These bounds improve coverage but do not guarantee that every token will meet a freshness target when providers or the queue are overloaded.

`GET /api/health` includes `watchingFreshness`: total watching tokens, never-checked count, count stale beyond 30 minutes (including never checked), and median/p95 check age in seconds. Percentiles exclude never-checked rows and are null for an empty observed set. Check age describes Keel's observation time, not guaranteed upstream quote freshness.

## Data

Migrations live in `db/migrations` and are the source of truth. Drizzle models in `src/lib/db/schema.ts` match them. Tables: `wallets`, `raw_events`, `tokens`, `token_checks`, `pipeline_jobs`, plus `provider_calls` and `market_cache` for budgets.

Three prices stay separate on every token: first seen, sniper buy, and our entry.

## Out of scope

No auto-trading, no private keys, no paid Birdeye or similar APIs, and no dependency on any other trading repository.


### Complete data export

Open **Settings → Export database** and supply `EXPORT_SECRET` (or `CRON_SECRET` when a separate export key is unset). The key is used in the request header, stays out of URLs/storage, and is cleared after an attempt. No key is exposed by the application. The protected `GET /api/export` streams JSONL from a read-only, repeatable-read database transaction. It includes every visible public application table, column metadata, all current rows, per-table counts and a final completion footer; there is no row/page cap. No production writes or migrations are involved.

Each `row.record` is PostgreSQL's JSON text stored as a string, preserving large integer/numeric literals without JavaScript rounding. Parse this text with an appropriate numeric-aware reader for analysis. The export is a review dataset rather than a PostgreSQL restore dump: database roles, functions, indexes and sequence state are not included. Use `pg_dump` for a full restore backup. Previously deleted records cannot be recovered through export. Raw discovery-event pruning is removed going forward so source evidence is retained; operational cache/provider/job cleanup remains unchanged. Alert observations are not pruned.

The UI verifies the final footer before offering the download, distinguishes failed/interrupted exports, and reports table/record totals. Server buffering is bounded with cursor batches and backpressure. Browser download buffering and the hosting function's 60-second limit still apply; oversized/slow exports fail visibly rather than returning a truncated file as complete. Use a direct database export tool for datasets exceeding those runtime limits. Protect downloaded files as they include wallet sources, source payloads and full research history.

### Live views and quote consistency

Watching and its two top-ten rankings share one 15-second overview request; settings diagnostics load only while their tab is visible. Alert statistics poll every ten seconds and token details every fifteen seconds. Polling deduplicates concurrent requests, bounds stalled fetches to fifteen seconds, pauses hidden/offline tabs and refreshes on visibility/focus/reconnection. A failed request retains the last response with an error; a different URL never inherits the previous URL's data.

List, search and detail presentation use the latest recorded market-check snapshot and its retrieval timestamp. Missing fields remain null instead of borrowing an older field. Empty refresh responses and failed hourly captures are retained as unavailable market checks, exposing gaps without refreshing the stored token age. Gains are computed from that same displayed quote and the stored entry/first-alert baseline; Telegram performance keeps its own immutable sent-alert baseline. Reading or polling an API does not itself fetch new provider data. Freshness depends on the separately running server pipeline and alert worker. Existing records are projected consistently without rewriting historical evidence.
