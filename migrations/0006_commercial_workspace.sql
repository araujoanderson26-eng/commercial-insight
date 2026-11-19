-- Additive profile: existing role constraint, logins and snapshots are preserved.
ALTER TABLE users ADD COLUMN update_only INTEGER NOT NULL DEFAULT 0 CHECK(update_only IN (0,1));

CREATE TABLE saved_reports (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  plan TEXT NOT NULL,
  question TEXT,
  favorite INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL
);
CREATE INDEX saved_reports_owner ON saved_reports(owner,scope_version,revision,created);
