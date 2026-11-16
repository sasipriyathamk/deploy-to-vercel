-- Paper trading research tables.
-- These tables are read-only extensions of the alert observation system.
-- They never replace or modify telegram_alerts or alert_observations.

-- ============================================================
-- Signal universe: every qualifying confidence observation,
-- not just those that reached the Telegram alert threshold.
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mint text NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN ('alert','research','watching','candidate')),
  -- signal_type meanings:
  --   'alert'     : confidence >= ALERT_CONFIDENCE and Telegram alert was sent
  --   'research'  : confidence >= ALERT_CONFIDENCE but no alert was sent (e.g. alerts disabled)
  --   'watching'  : token is status=watching but confidence < ALERT_CONFIDENCE
  --   'candidate' : token is status=candidate, any confidence
  confidence integer NOT NULL,
  qualified_at timestamptz NOT NULL,
  snapshot_at timestamptz NOT NULL,
  basis text NOT NULL CHECK (basis IN ('price','mcap')),
  entry_value double precision NOT NULL CHECK (entry_value > 0),
  price_usd double precision,
  mcap_usd double precision,
  liq_usd double precision,
  vol_m5 double precision,
  alert_id bigint REFERENCES telegram_alerts(id),
  strategy_id text,
  strategy_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_signals_mint ON paper_signals(mint, qualified_at);
CREATE INDEX IF NOT EXISTS paper_signals_confidence ON paper_signals(confidence, qualified_at);
CREATE INDEX IF NOT EXISTS paper_signals_type ON paper_signals(signal_type, qualified_at);
CREATE INDEX IF NOT EXISTS paper_signals_alert ON paper_signals(alert_id) WHERE alert_id IS NOT NULL;

-- ============================================================
-- Observations attached to research signals (separate from
-- alert_observations which are owned by the alerts system).
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal_id bigint NOT NULL REFERENCES paper_signals(id),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'dexscreener',
  freshness text NOT NULL DEFAULT 'live' CHECK (freshness IN ('live','cached','stale','unknown')),
  price_usd double precision,
  mcap_usd double precision,
  liq_usd double precision,
  vol_m5 double precision,
  vol_h1 double precision,
  buys_m5 integer,
  sells_m5 integer,
  UNIQUE(signal_id, observed_at)
);
CREATE INDEX IF NOT EXISTS paper_obs_signal_time ON paper_observations(signal_id, observed_at);

-- ============================================================
-- Confidence calibration cache: pre-aggregated per band/window.
-- Recalculated by the calibration worker; never edited manually.
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_calibration (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  confidence_lo integer NOT NULL,
  confidence_hi integer NOT NULL,
  window_minutes integer NOT NULL,
  signal_type text NOT NULL DEFAULT 'alert',
  computed_at timestamptz NOT NULL DEFAULT now(),
  n_signals integer NOT NULL DEFAULT 0,
  n_with_data integer NOT NULL DEFAULT 0,
  -- Hit rates
  pct_plus25 double precision,
  pct_plus50 double precision,
  pct_plus100 double precision,
  pct_plus200 double precision,
  pct_plus500 double precision,
  -- Fall rates
  pct_minus10 double precision,
  pct_minus20 double precision,
  pct_minus30 double precision,
  pct_minus50 double precision,
  -- MAE / MFE
  median_mae double precision,
  median_mfe double precision,
  -- Recovery
  recovery_probability double precision,
  median_recovery_minutes double precision,
  -- 2x vs -30% race
  prob_2x_before_30 double precision,
  prob_30_before_2x double precision,
  -- Time to peak
  median_minutes_to_peak double precision,
  -- Failure rate (fell >50% and never recovered)
  failure_rate double precision,
  -- Censoring info
  n_censored integer NOT NULL DEFAULT 0,
  UNIQUE(confidence_lo, confidence_hi, window_minutes, signal_type)
);

-- ============================================================
-- Drawdown episodes: extended tracking for every peak-to-trough
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_drawdown_episodes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id bigint NOT NULL REFERENCES telegram_alerts(id),
  -- The running peak before the fall
  high_observed_at timestamptz NOT NULL,
  high_value double precision NOT NULL,
  high_confidence integer,
  high_liq_usd double precision,
  high_vol_m5 double precision,
  -- The trough
  trough_observed_at timestamptz,
  trough_value double precision,
  trough_liq_usd double precision,
  trough_vol_m5 double precision,
  -- Episode metrics
  depth_pct double precision,
  minutes_to_trough double precision,
  -- Momentum confirmation
  momentum_confirmed_at timestamptz,
  momentum_value double precision,
  rebound_pct double precision,
  -- Recovery milestones (each is nullable — event may not have happened yet)
  entry_recovered_at timestamptz,     -- price crossed back above entry_value
  local_high_recovered_at timestamptz, -- price crossed back above high_value
  ath_recovered_at timestamptz,       -- price crossed back above token's ATH at drawdown start
  new_ath_at timestamptz,             -- price set a new ATH above all previous
  -- Final outcome
  episode_failed boolean,             -- fell >50% and never recovered within 72h
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_dd_alert ON paper_drawdown_episodes(alert_id);

-- ============================================================
-- Portfolio simulation
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_portfolios (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  strategy_id text NOT NULL DEFAULT 'default',
  strategy_version integer NOT NULL DEFAULT 1,
  starting_capital double precision NOT NULL DEFAULT 1000,
  position_sizing text NOT NULL DEFAULT 'fixed_dollar' CHECK (position_sizing IN ('fixed_dollar','percentage')),
  position_size double precision NOT NULL DEFAULT 100,  -- dollars or pct
  max_positions integer NOT NULL DEFAULT 5,
  max_exposure_per_token double precision NOT NULL DEFAULT 0.2,  -- fraction of portfolio
  max_total_exposure double precision NOT NULL DEFAULT 0.8,      -- fraction of portfolio
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id bigint NOT NULL REFERENCES paper_portfolios(id),
  signal_id bigint NOT NULL REFERENCES paper_signals(id),
  mint text NOT NULL,
  -- Entry
  entry_at timestamptz NOT NULL,
  entry_quote_price double precision NOT NULL,  -- hypothetical quoted price
  entry_fill_price double precision NOT NULL,   -- quoted * (1 + slippage)
  entry_slippage_pct double precision NOT NULL DEFAULT 0.5,
  entry_fee_pct double precision NOT NULL DEFAULT 0.1,
  size_usd double precision NOT NULL,           -- capital deployed
  -- Exit
  exit_at timestamptz,
  exit_quote_price double precision,
  exit_fill_price double precision,
  exit_slippage_pct double precision,
  exit_fee_pct double precision,
  exit_reason text CHECK (exit_reason IN ('stop_loss','trailing_stop','take_profit','time_exit','manual',NULL)),
  -- P&L
  realised_pnl_usd double precision,
  realised_pnl_pct double precision,
  -- Peak tracking for trailing stop
  peak_price double precision,
  peak_at timestamptz,
  -- Mae / MFE
  mae_pct double precision,
  mfe_pct double precision,
  -- State
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_pos_portfolio ON paper_positions(portfolio_id, status);
CREATE INDEX IF NOT EXISTS paper_pos_signal ON paper_positions(signal_id);

-- Portfolio equity snapshots (daily)
CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id bigint NOT NULL REFERENCES paper_portfolios(id),
  snapshot_date date NOT NULL,
  cash double precision NOT NULL,
  open_positions_value double precision NOT NULL,
  equity double precision NOT NULL,  -- cash + open positions mark-to-market
  realised_pnl_usd double precision NOT NULL DEFAULT 0,
  unrealised_pnl_usd double precision NOT NULL DEFAULT 0,
  drawdown_pct double precision,
  peak_equity double precision,
  UNIQUE(portfolio_id, snapshot_date)
);

-- ============================================================
-- Strategy registry: versioned strategy definitions
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_strategies (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}',
  entry_conditions jsonb NOT NULL DEFAULT '{}',
  exit_conditions jsonb NOT NULL DEFAULT '{}',
  cost_assumptions jsonb NOT NULL DEFAULT '{"slippage_pct": 0.5, "fee_pct": 0.1}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(strategy_id, version)
);
