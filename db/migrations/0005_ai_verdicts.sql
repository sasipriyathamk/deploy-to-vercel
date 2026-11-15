CREATE TABLE IF NOT EXISTS ai_verdicts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verdict text NOT NULL,
  conviction integer,
  bull_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  red_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  narrative text,
  invalidation text,
  holder_summary text,
  reasoning text,
  unavailable_reason text,
  model text,
  inputs_hash text NOT NULL,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd double precision,
  stage text,
  price_usd double precision,
  mcap_usd double precision,
  thesis_fingerprint text,
  thesis_newest_at timestamptz,
  theses jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger text NOT NULL,
  counts_toward_cap boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ai_verdicts_mint_created ON ai_verdicts (mint, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_verdicts_cap ON ai_verdicts (created_at) WHERE counts_toward_cap;
