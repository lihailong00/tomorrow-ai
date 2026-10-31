-- Portable on SQLite and PostgreSQL; leave existing cached rows unbound.
-- A legacy row without a fingerprint is rejected on retry, never reinterpreted.
CREATE TABLE IF NOT EXISTS chat_request_inputs (
 request_key TEXT PRIMARY KEY REFERENCES chat_requests(request_key) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resources_owner_activity ON resources(user_id, kind, updated_at);
