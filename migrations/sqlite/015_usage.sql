-- Portable SQLite/PostgreSQL request ledger. Existing aggregate history is not backfilled.
CREATE TABLE IF NOT EXISTS usage_recording (
 id BIGINT PRIMARY KEY, recording_start BIGINT NOT NULL, pricebook_json TEXT NOT NULL DEFAULT '',
 pricebook_revision BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_requests (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, dispatched_at BIGINT NOT NULL,
 identity_json TEXT NOT NULL, capability TEXT NOT NULL, purpose TEXT NOT NULL,
 price_json TEXT NOT NULL, outcome_json TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS usage_requests_owner_date ON usage_requests(user_id,dispatched_at);
CREATE TABLE IF NOT EXISTS usage_reminders (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled BIGINT NOT NULL, threshold_cny_micros BIGINT NOT NULL
);
