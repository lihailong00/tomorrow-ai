-- Creation intents outlive resource deletion. No resource FK/expiry: a delayed
-- retry must report the deletion instead of recreating an enabled schedule.
CREATE TABLE IF NOT EXISTS resource_creation_requests (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 PRIMARY KEY(user_id,kind,request_id)
);
