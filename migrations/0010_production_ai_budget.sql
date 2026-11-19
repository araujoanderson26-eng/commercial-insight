-- Additive and independent of the HML-only migrations 0007-0009. No existing data is changed.
CREATE TABLE ai_production_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 administrator_id TEXT REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 1,
 monthly_cap_nano_usd INTEGER NOT NULL DEFAULT 20000000000 CHECK(monthly_cap_nano_usd BETWEEN 0 AND 20000000000),
 organization_id TEXT, project_id TEXT,
 -- Lifetime ceiling = previous reservations + exclusively allocated, verified available credits.
 -- This ceiling NEVER resets at a month boundary. Zero means no verified funding.
 credit_ceiling_nano_usd INTEGER NOT NULL DEFAULT 0 CHECK(credit_ceiling_nano_usd>=0),
 credit_verified_at INTEGER NOT NULL DEFAULT 0, credit_valid_until INTEGER NOT NULL DEFAULT 0,
 verification_reference TEXT,
 model TEXT NOT NULL DEFAULT 'gpt-4.1-mini-2025-04-14',
 pricing_valid_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ai_production_policy(id) VALUES(1);
CREATE TABLE ai_production_attempts (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), policy_revision INTEGER NOT NULL,
 month TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN('plano_comercial','leitura_comercial')),
 reserved_nano_usd INTEGER NOT NULL CHECK(reserved_nano_usd>0),
 reserved_input_tokens INTEGER NOT NULL, output_limit INTEGER NOT NULL CHECK(output_limit=1200),
 status TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER,
 http_status INTEGER, response_model TEXT, request_id TEXT, provider_code TEXT,
 input_tokens INTEGER, output_tokens INTEGER, usage_upper_nano_usd INTEGER
);
CREATE INDEX ai_production_month ON ai_production_attempts(month);
CREATE INDEX ai_production_status ON ai_production_attempts(status);
CREATE TABLE ai_production_alerts (
 month TEXT NOT NULL, threshold_nano_usd INTEGER NOT NULL CHECK(threshold_nano_usd IN(10000000000,16000000000,20000000000)),
 event TEXT NOT NULL CHECK(event IN('reservation_threshold','budget_blocked')),
 committed_nano_usd INTEGER NOT NULL, created INTEGER NOT NULL,
 PRIMARY KEY(month,threshold_nano_usd,event)
);
-- Threshold events are committed in the SAME transaction as the reservation, even if the Worker dies.
CREATE TRIGGER ai_production_reservation_alert AFTER INSERT ON ai_production_attempts BEGIN
 INSERT OR IGNORE INTO ai_production_alerts(month,threshold_nano_usd,event,committed_nano_usd,created)
 SELECT NEW.month,t.threshold,'reservation_threshold',
   (SELECT SUM(reserved_nano_usd) FROM ai_production_attempts WHERE month=NEW.month),NEW.created
 FROM (SELECT 10000000000 threshold UNION ALL SELECT 16000000000 UNION ALL SELECT 20000000000) t
 WHERE (SELECT SUM(reserved_nano_usd) FROM ai_production_attempts WHERE month=NEW.month)>=t.threshold;
END;
-- Reservations and their month are immutable: retries/deployments cannot free a charged allowance.
CREATE TRIGGER ai_production_reservation_immutable BEFORE UPDATE OF reserved_nano_usd,month,owner,model,policy_revision,reserved_input_tokens,output_limit,created,purpose ON ai_production_attempts
BEGIN SELECT RAISE(ABORT,'AI reservations are immutable'); END;
CREATE TRIGGER ai_production_attempt_retained BEFORE DELETE ON ai_production_attempts
BEGIN SELECT RAISE(ABORT,'AI ledger must be retained'); END;
