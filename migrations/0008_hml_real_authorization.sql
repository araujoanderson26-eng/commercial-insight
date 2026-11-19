-- Payload-free linkage for the explicitly authorized, ordered real-data HML trial.
ALTER TABLE hml_openai_attempts ADD COLUMN authorization_run_id TEXT;
ALTER TABLE hml_openai_attempts ADD COLUMN question_hash TEXT;
