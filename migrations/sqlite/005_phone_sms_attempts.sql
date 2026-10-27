-- One persistent row serializes quota admission across all API processes.
-- The first admission imports legacy counters under this lock, exactly once.
CREATE TABLE IF NOT EXISTS phone_sms_guard (
 id BIGINT PRIMARY KEY CHECK (id=1),
 legacy_imported BIGINT NOT NULL DEFAULT 0
);
INSERT INTO phone_sms_guard(id,legacy_imported) VALUES(1,0) ON CONFLICT(id) DO NOTHING;

-- Store admissions, including failed or ambiguous deliveries. NULL phone is a
-- conservative legacy global admission whose original phone is no longer known.
CREATE TABLE IF NOT EXISTS phone_sms_attempts (
 id TEXT PRIMARY KEY,
 phone TEXT,
 requested_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_sms_attempts_time ON phone_sms_attempts(requested_at DESC);
CREATE INDEX IF NOT EXISTS phone_sms_attempts_phone_time ON phone_sms_attempts(phone,requested_at DESC);
