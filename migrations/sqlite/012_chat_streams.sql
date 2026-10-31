-- Compatible with SQLite and PostgreSQL. Request identity and effects survive
-- subscriber disconnects; expired producers are never silently restarted.
CREATE TABLE IF NOT EXISTS chat_streams (
 request_key TEXT PRIMARY KEY REFERENCES chat_requests(request_key) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 attempt_token TEXT NOT NULL,
 agent_run_id TEXT,
 slots_enabled BIGINT NOT NULL DEFAULT 0,
 accepted TEXT,
 tool_status TEXT,
 partial TEXT NOT NULL DEFAULT '',
 previous_content TEXT,
 attempt BIGINT NOT NULL DEFAULT 1,
 reset_pending BIGINT NOT NULL DEFAULT 0,
 text_turn BIGINT NOT NULL DEFAULT 0,
 sequence BIGINT NOT NULL DEFAULT 0,
 source_sequence BIGINT NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'running',
 error TEXT,
 lease_until BIGINT NOT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_stream_events (
 request_key TEXT NOT NULL REFERENCES chat_streams(request_key) ON DELETE CASCADE,
 sequence BIGINT NOT NULL,
 kind TEXT NOT NULL,
 body TEXT NOT NULL,
 PRIMARY KEY(request_key,sequence)
);
CREATE INDEX IF NOT EXISTS chat_streams_agent_run ON chat_streams(agent_run_id);
CREATE TABLE IF NOT EXISTS agent_operation_slots (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 operation_slot BIGINT NOT NULL,
 operation_key TEXT NOT NULL,
 PRIMARY KEY(run_id,operation_slot),
 UNIQUE(run_id,operation_key)
);
