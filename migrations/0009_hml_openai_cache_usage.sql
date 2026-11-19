-- New observations only. Historical nulls are intentionally preserved as unknown cache usage.
ALTER TABLE hml_openai_attempts ADD COLUMN cached_input_tokens INTEGER
  CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0);
