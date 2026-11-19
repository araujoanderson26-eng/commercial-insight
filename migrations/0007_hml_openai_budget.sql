-- Additive, payload-free accounting for the explicitly enabled HML OpenAI trial.
-- Production does not access this table when HML_OPENAI_BUDGET_USD is absent.
CREATE TABLE hml_openai_attempts (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  reserved_nano_usd INTEGER NOT NULL CHECK(reserved_nano_usd > 0),
  reserved_input_tokens INTEGER NOT NULL,
  output_limit INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_model TEXT,
  request_id TEXT,
  provider_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  actual_nano_usd INTEGER,
  created INTEGER NOT NULL
);
