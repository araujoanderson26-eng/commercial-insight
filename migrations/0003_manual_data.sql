-- Additive: authentication, settings and conversations are preserved.
CREATE TABLE ci_sources (
 id TEXT PRIMARY KEY CHECK(id='commercial-main'),
 source TEXT NOT NULL DEFAULT 'powerbi' CHECK(source IN ('manual','powerbi')),
 active_version_id TEXT, generation INTEGER NOT NULL DEFAULT 0, latest_import_id TEXT,
 stale_days INTEGER NOT NULL DEFAULT 7 CHECK(stale_days BETWEEN 1 AND 365),
 allow_ai INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL
);
INSERT INTO ci_sources(id,updated) VALUES('commercial-main',unixepoch());
CREATE TABLE ci_imports (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 owner TEXT NOT NULL, actor TEXT NOT NULL, filename TEXT NOT NULL,
 bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, object_key TEXT NOT NULL,
 upload_id TEXT, status TEXT NOT NULL, base_generation INTEGER NOT NULL,
 uploaded_bytes INTEGER NOT NULL DEFAULT 0, processed_bytes INTEGER NOT NULL DEFAULT 0,
 part_cursor INTEGER NOT NULL DEFAULT 0, rows INTEGER NOT NULL DEFAULT 0,
 tables INTEGER NOT NULL DEFAULT 0, manifest TEXT, report TEXT,
 error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, published INTEGER,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 UNIQUE(sha256,bytes)
);
CREATE INDEX ci_import_queue ON ci_imports(status,seq);
CREATE TABLE ci_upload_parts (
 import_id TEXT NOT NULL REFERENCES ci_imports(id), part INTEGER NOT NULL,
 etag TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(import_id,part)
);
CREATE TABLE ci_parts (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), table_id TEXT NOT NULL,
 part INTEGER NOT NULL, rows INTEGER NOT NULL, sha256 TEXT NOT NULL,
 PRIMARY KEY(version_id,table_id,part)
);
CREATE TABLE ci_raw_rows (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), table_id TEXT NOT NULL,
 row_no INTEGER NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(version_id,table_id,row_no)
);
CREATE TABLE ci_facts (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 date TEXT NOT NULL, region TEXT NOT NULL, client TEXT NOT NULL,
 product TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL,
 value TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_fact_scope ON ci_facts(version_id,region,client,date);
CREATE INDEX ci_fact_date ON ci_facts(version_id,date);
ALTER TABLE turns ADD COLUMN source_version TEXT;
ALTER TABLE turns ADD COLUMN source_type TEXT;
