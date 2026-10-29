-- Shared SQLite/PostgreSQL schema; personal todos are independent of execution tasks.
CREATE TABLE IF NOT EXISTS todos (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL, status TEXT NOT NULL, due_at BIGINT, version BIGINT NOT NULL,
 prepare_version BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS todos_owner_status ON todos(user_id,status,created_at,id);
CREATE TABLE IF NOT EXISTS todo_candidates (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL, source_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 todo_id TEXT NOT NULL, PRIMARY KEY(user_id,source_kind,source_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS todo_extractions (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL, source_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 todo_ids TEXT NOT NULL, PRIMARY KEY(user_id,source_kind,source_id,content_hash)
);
CREATE TABLE IF NOT EXISTS todo_extraction_attempts (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL, source_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 attempt_token TEXT NOT NULL, lease_until BIGINT NOT NULL, updated_at BIGINT NOT NULL,
 PRIMARY KEY(user_id,source_kind,source_id,content_hash)
);
-- Also initialized by IntegrationState. Rows only arrive through confirmed imports.
CREATE TABLE IF NOT EXISTS integration_imports (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_app TEXT NOT NULL,title TEXT NOT NULL,
 body TEXT NOT NULL,source_url TEXT NOT NULL,external_key TEXT NOT NULL,created_at BIGINT NOT NULL,
 UNIQUE(user_id,source_app,external_key)
);
