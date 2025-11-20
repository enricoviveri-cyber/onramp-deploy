CREATE TABLE IF NOT EXISTS custom_tokens (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  network TEXT NOT NULL,
  price_fiat NUMERIC(18,8) NOT NULL,
  fiat_currency CHAR(3) NOT NULL,
  decimals INT NOT NULL DEFAULT 18,
  contract_address TEXT,
  logo_url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  inventory NUMERIC(38,18) NOT NULL DEFAULT 0,
  reserved NUMERIC(38,18) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  hold_id UUID PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES custom_tokens(id) ON DELETE CASCADE,
  amount NUMERIC(38,18) NOT NULL,
  expiry TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  order_id UUID,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys (created_at);
