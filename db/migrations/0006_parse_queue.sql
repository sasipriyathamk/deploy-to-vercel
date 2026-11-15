ALTER TABLE wallets ADD COLUMN IF NOT EXISTS resume_before text;

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS socials jsonb;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS promotion_hits text;

CREATE TABLE IF NOT EXISTS pipeline_lock (
  id integer PRIMARY KEY,
  holder text,
  locked_at timestamptz,
  CONSTRAINT pipeline_lock_singleton CHECK (id = 1)
);

INSERT INTO pipeline_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS provider_slots (
  provider text PRIMARY KEY,
  next_at timestamptz NOT NULL DEFAULT now(),
  backoff_until timestamptz
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  route text PRIMARY KEY,
  started_at timestamptz,
  finished_at timestamptz
);

UPDATE pipeline_jobs
SET status = 'pending',
    attempts = 0,
    run_after = now(),
    locked_at = NULL,
    last_error = NULL
WHERE status = 'failed'
  AND type IN ('parse', 'parse_rpc')
  AND (
    COALESCE(last_error, '') ILIKE '%maxSupportedTransactionVersion%'
    OR COALESCE(last_error, '') ILIKE '%transaction version%'
  );

UPDATE tokens AS token
SET promotion_hits = picked.hits
FROM (
  SELECT DISTINCT ON (mint) mint, flags->>'hits' AS hits
  FROM token_checks
  WHERE flags->>'promoted' = 'true'
    AND COALESCE(flags->>'hits', '') <> ''
  ORDER BY mint, checked_at DESC
) AS picked
WHERE token.mint = picked.mint
  AND token.promotion_hits IS NULL;

INSERT INTO tokens (mint, status, score, first_seen_at, sniper_buy_tx, sniper_buy_at, sniper_buy_sol, sniper_wallet)
SELECT
  event.mint,
  'seen',
  50,
  COALESCE(event.block_time, event.ingested_at),
  CASE WHEN event.side = 'buy' THEN event.signature ELSE NULL END,
  CASE WHEN event.side = 'buy' THEN COALESCE(event.block_time, event.ingested_at) ELSE NULL END,
  CASE WHEN event.side = 'buy' AND event.sol_delta < 0 THEN abs(event.sol_delta) ELSE NULL END,
  event.wallet
FROM (
  SELECT DISTINCT ON (mint)
    mint, signature, wallet, side, sol_delta, block_time, ingested_at
  FROM raw_events
  WHERE mint IS NOT NULL
    AND err = false
    AND side IN ('buy', 'sell')
    AND mint NOT IN (
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
      '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
    )
  ORDER BY mint, CASE WHEN side = 'buy' THEN 0 ELSE 1 END, block_time ASC NULLS LAST
) AS event
WHERE NOT EXISTS (SELECT 1 FROM tokens existing WHERE existing.mint = event.mint);

INSERT INTO pipeline_jobs (type, payload, run_after, status, attempts)
SELECT 'enrich_t0', jsonb_build_object('mint', token.mint), now(), 'pending', 0
FROM tokens token
WHERE token.status = 'seen'
  AND token.sniper_buy_tx IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pipeline_jobs job
    WHERE job.type = 'enrich_t0'
      AND job.payload->>'mint' = token.mint
  );
