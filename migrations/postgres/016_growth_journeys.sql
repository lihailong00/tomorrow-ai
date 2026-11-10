CREATE TABLE IF NOT EXISTS growth_journeys (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 goal TEXT NOT NULL,kind TEXT NOT NULL,daily_minutes BIGINT NOT NULL,
 status TEXT NOT NULL,task_id TEXT,attempts BIGINT NOT NULL DEFAULT 0,dispatches BIGINT NOT NULL DEFAULT 1,model_attempt BIGINT,
 error TEXT,version BIGINT NOT NULL DEFAULT 1,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS growth_journey_owner ON growth_journeys(user_id,created_at);
CREATE TABLE IF NOT EXISTS growth_journey_steps (
 id TEXT PRIMARY KEY,journey_id TEXT NOT NULL REFERENCES growth_journeys(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,position BIGINT NOT NULL,
 title TEXT NOT NULL,description TEXT NOT NULL,criterion TEXT NOT NULL,minutes BIGINT NOT NULL,
 todo_id TEXT,skipped BIGINT NOT NULL DEFAULT 0,difficulty TEXT,version BIGINT NOT NULL DEFAULT 1,
 UNIQUE(journey_id,position)
);
CREATE INDEX IF NOT EXISTS growth_journey_step_owner ON growth_journey_steps(user_id,journey_id,position);
