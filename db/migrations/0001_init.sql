CREATE TABLE IF NOT EXISTS wallets (
  address text PRIMARY KEY,
  label text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_signature text,
  last_polled_at timestamptz,
  last_ingest_at timestamptz
);

CREATE TABLE IF NOT EXISTS raw_events (
  signature text PRIMARY KEY,
  wallet text NOT NULL,
  slot bigint,
  block_time timestamptz,
  err boolean NOT NULL DEFAULT false,
  programs text[] NOT NULL DEFAULT '{}',
  mint text,
  side text NOT NULL DEFAULT 'unknown',
  sol_delta double precision,
  token_delta double precision,
  raw_json jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raw_events_side_chk CHECK (side IN ('buy', 'sell', 'unknown'))
);

CREATE INDEX IF NOT EXISTS raw_events_wallet_time ON raw_events (wallet, block_time DESC);
CREATE INDEX IF NOT EXISTS raw_events_mint ON raw_events (mint);
CREATE INDEX IF NOT EXISTS raw_events_ingested ON raw_events (ingested_at DESC);

CREATE TABLE IF NOT EXISTS tokens (
  mint text PRIMARY KEY,
  symbol text,
  name text,
  decimals integer,
  first_seen_at timestamptz,
  first_seen_price_usd double precision,
  first_seen_mcap_usd double precision,
  sniper_buy_price_usd double precision,
  sniper_buy_mcap_usd double precision,
  sniper_buy_sol double precision,
  sniper_buy_tx text,
  sniper_buy_at timestamptz,
  sniper_wallet text,
  entry_at timestamptz,
  entry_price_usd double precision,
  entry_mcap_usd double precision,
  status text NOT NULL DEFAULT 'seen',
  score integer NOT NULL DEFAULT 50,
  score_breakdown jsonb,
  last_price_usd double precision,
  last_mcap_usd double precision,
  last_liq_usd double precision,
  last_vol_m5 double precision,
  last_vol_h1 double precision,
  last_buys_m5 integer,
  last_sells_m5 integer,
  last_buys_h1 integer,
  last_sells_h1 integer,
  last_buyers_estimate integer,
  last_checked_at timestamptz,
  gain_pct double precision,
  gain_basis text,
  ath_price_usd double precision,
  ath_mcap_usd double precision,
  ath_gain_pct double precision,
  ath_at timestamptz,
  archive_reason text,
  archived_at timestamptz,
  revive_count integer NOT NULL DEFAULT 0,
  revived_at timestamptz,
  sniper_still_holding boolean,
  venue text,
  graduated boolean NOT NULL DEFAULT false,
  t5_vol_m5 double precision,
  weak_since timestamptz,
  hold_checked_at timestamptz,
  pair_count integer,
  top_holder_pct double precision,
  mint_revoked boolean,
  freeze_revoked boolean,
  rugcheck_normalised double precision,
  CONSTRAINT tokens_status_chk CHECK (
    status IN ('seen', 'candidate', 'watching', 'archived', 'rejected_junk')
  )
);

CREATE INDEX IF NOT EXISTS tokens_status_score ON tokens (status, score DESC);
CREATE INDEX IF NOT EXISTS tokens_symbol ON tokens (symbol);
CREATE INDEX IF NOT EXISTS tokens_name ON tokens (name);
CREATE INDEX IF NOT EXISTS tokens_status_checked ON tokens (status, last_checked_at);

CREATE TABLE IF NOT EXISTS token_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mint text NOT NULL REFERENCES tokens (mint) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL,
  payload jsonb,
  passed boolean,
  flags jsonb
);

CREATE INDEX IF NOT EXISTS token_checks_mint_time ON token_checks (mint, checked_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_after timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  CONSTRAINT pipeline_jobs_status_chk CHECK (status IN ('pending', 'running', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS pipeline_jobs_status_run ON pipeline_jobs (status, run_after);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_jobs_pending_mint
  ON pipeline_jobs (type, (payload->>'mint'))
  WHERE status = 'pending' AND payload ? 'mint';

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_jobs_pending_sig
  ON pipeline_jobs (type, (payload->>'signature'))
  WHERE status = 'pending' AND payload ? 'signature';

CREATE TABLE IF NOT EXISTS provider_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL,
  status integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_calls_provider_time ON provider_calls (provider, created_at DESC);

CREATE TABLE IF NOT EXISTS market_cache (
  cache_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
