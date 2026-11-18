CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','diretoria','gerente','comercial')),
 regions TEXT NOT NULL DEFAULT '[]', clients TEXT NOT NULL DEFAULT '[]',
 national INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
 entra_oid TEXT, scope_version INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL
);
CREATE UNIQUE INDEX unique_entra ON users(entra_oid) WHERE entra_oid IS NOT NULL;
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL, expires INTEGER NOT NULL, seen INTEGER NOT NULL);
CREATE INDEX session_owner ON sessions(user_id);
CREATE TABLE recovery (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE throttle (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE oauth_state (state TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE microsoft_tokens (owner TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL, encrypted TEXT NOT NULL);
CREATE TABLE conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX history_scope ON conversations(owner,version,revision,updated);
CREATE TABLE turns (id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, question TEXT NOT NULL, plan TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX turns_thread ON turns(conversation,created);
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT NOT NULL, target TEXT, created INTEGER NOT NULL);
CREATE INDEX audit_time ON audit(created);
