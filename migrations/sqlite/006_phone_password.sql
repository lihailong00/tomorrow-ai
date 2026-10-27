-- Phone credentials are separate from legacy email authentication.
CREATE TABLE IF NOT EXISTS phone_credentials (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 password_hash TEXT NOT NULL,
 updated_at BIGINT NOT NULL
);

-- Registration, password reset and password login share this first-write lock.
CREATE TABLE IF NOT EXISTS phone_password_guard (
 id BIGINT PRIMARY KEY CHECK (id=1),
 singleton BIGINT NOT NULL DEFAULT 0
);
INSERT INTO phone_password_guard(id,singleton) VALUES(1,0) ON CONFLICT(id) DO NOTHING;

-- Pending verification and failed attempts share the same bounded admission log.
CREATE TABLE IF NOT EXISTS phone_login_attempts (
 id TEXT PRIMARY KEY,
 phone TEXT NOT NULL,
 requested_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_login_attempts_phone_time ON phone_login_attempts(phone,requested_at DESC);
CREATE INDEX IF NOT EXISTS phone_login_attempts_time ON phone_login_attempts(requested_at);
