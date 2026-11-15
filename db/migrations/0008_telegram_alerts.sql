-- Telegram alerts are separate from legacy candidate first-alert stamps and confidence_alerts.
CREATE TABLE IF NOT EXISTS telegram_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mint text NOT NULL UNIQUE,
  qualified_at timestamptz NOT NULL,
  snapshot_at timestamptz NOT NULL,
  confidence integer NOT NULL CHECK (confidence >= 75),
  stage text NOT NULL,
  snapshot jsonb NOT NULL,
  basis text NOT NULL CHECK (basis IN ('price', 'mcap')),
  entry_value double precision NOT NULL CHECK (entry_value > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waiting','sending','sent','unknown','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  sent_at timestamptz,
  telegram_message_id bigint,
  delivery_error text,
  next_snapshot_at timestamptz,
  snapshot_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND telegram_message_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS telegram_alerts_delivery ON telegram_alerts(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS telegram_alerts_monitor ON telegram_alerts(next_snapshot_at) WHERE status = 'sent';
CREATE TABLE IF NOT EXISTS alert_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id bigint NOT NULL REFERENCES telegram_alerts(id),
  event_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL,
  target_at timestamptz,
  price_usd double precision,
  mcap_usd double precision,
  snapshot jsonb NOT NULL,
  UNIQUE(alert_id, event_key)
);
CREATE INDEX IF NOT EXISTS alert_observations_path ON alert_observations(alert_id, observed_at, id);
