-- Portable schema, applied to both SQLite and PostgreSQL by Repository::connect.
CREATE TABLE IF NOT EXISTS agent_runs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, conversation_id TEXT,
 scope TEXT NOT NULL, task_id TEXT, task_attempt BIGINT,
 token_hash TEXT NOT NULL, status TEXT NOT NULL, lease_until BIGINT NOT NULL,
 result TEXT, usage TEXT, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_runs_owner ON agent_runs(user_id, created_at);
CREATE TABLE IF NOT EXISTS agent_operations (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 operation_key TEXT NOT NULL, tool_name TEXT NOT NULL, arguments TEXT NOT NULL,
 result TEXT NOT NULL, created_at BIGINT NOT NULL,
 PRIMARY KEY(run_id, operation_key)
);
CREATE TABLE IF NOT EXISTS agent_events (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 sequence BIGINT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL,
 PRIMARY KEY(run_id, sequence)
);
