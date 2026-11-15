CREATE TABLE IF NOT EXISTS telegram_alert_milestones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id bigint NOT NULL REFERENCES telegram_alerts(id),
  observation_id bigint NOT NULL REFERENCES alert_observations(id),
  multiple integer NOT NULL CHECK (multiple IN (2,3,5,10)),
  observed_value double precision NOT NULL,
  observed_at timestamptz NOT NULL,
  elapsed_seconds double precision NOT NULL CHECK (elapsed_seconds >= 0),
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','unknown','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  sent_at timestamptz,
  telegram_message_id bigint,
  delivery_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(alert_id,multiple),
  CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND telegram_message_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS telegram_alert_milestones_delivery ON telegram_alert_milestones(status,next_attempt_at);
