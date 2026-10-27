-- Keep the logical run sequence durable while bounding each execution attempt.
-- One cursor per run remains even when older display events are pruned.
CREATE TABLE IF NOT EXISTS agent_event_cursors (
 run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL,
 next_sequence BIGINT NOT NULL,
 attempt_events BIGINT NOT NULL DEFAULT 0
);
