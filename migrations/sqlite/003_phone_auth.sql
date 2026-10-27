-- Portable additive migration; existing email accounts and ownership are retained.
CREATE TABLE IF NOT EXISTS phone_identities (
 phone TEXT PRIMARY KEY,
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS phone_codes (
 id TEXT NOT NULL UNIQUE,
 phone TEXT NOT NULL,
 purpose TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 expires_at BIGINT NOT NULL,
 attempts BIGINT NOT NULL DEFAULT 0,
 consumed_at BIGINT,
 created_at BIGINT NOT NULL,
 PRIMARY KEY (phone, purpose)
);
