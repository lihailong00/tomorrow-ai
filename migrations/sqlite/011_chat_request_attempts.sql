-- An attempt is separate from the input fingerprint: a stale attempt must not
-- release or commit a later reservation for the same request and same input.
CREATE TABLE IF NOT EXISTS chat_request_attempts (
 request_key TEXT PRIMARY KEY REFERENCES chat_requests(request_key) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 attempt_token TEXT NOT NULL
);
