CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 name TEXT NOT NULL, timezone TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS resources_owner_kind ON resources(user_id, kind, created_at);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL, prompt TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
 requires_approval BIGINT NOT NULL DEFAULT 0, approval_summary TEXT,
 result TEXT, error TEXT, attempts BIGINT NOT NULL DEFAULT 0,
 progress BIGINT NOT NULL DEFAULT 0, summary TEXT, model_mode TEXT NOT NULL DEFAULT 'local',
 approved_at TEXT, artifact_id TEXT, steps TEXT NOT NULL DEFAULT '[]',
 next_attempt_at BIGINT NOT NULL DEFAULT 0, claimed_until BIGINT NOT NULL DEFAULT 0,
 created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, schedule_id TEXT,
 idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, next_attempt_at, claimed_until);
CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL, prompt TEXT NOT NULL, frequency TEXT NOT NULL, time_of_day TEXT NOT NULL, timezone TEXT NOT NULL,
 enabled BIGINT NOT NULL DEFAULT 1, next_run_at BIGINT NOT NULL,
 last_run_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at);
CREATE TABLE IF NOT EXISTS task_events (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, message TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, created_at);
CREATE TABLE IF NOT EXISTS chat_requests (
 request_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 response TEXT, created_at BIGINT NOT NULL
);
