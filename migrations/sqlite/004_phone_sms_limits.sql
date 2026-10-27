-- Atomic cross-purpose SMS quotas. Pending/failed sends retain their admission.
CREATE TABLE IF NOT EXISTS phone_sms_limits (
 scope TEXT PRIMARY KEY,
 window_started_at BIGINT NOT NULL,
 last_requested_at BIGINT NOT NULL,
 requests BIGINT NOT NULL
);
