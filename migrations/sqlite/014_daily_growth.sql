-- Portable SQLite/PostgreSQL. No existing completion history is backfilled.
CREATE TABLE IF NOT EXISTS growth_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL, version BIGINT NOT NULL, guard BIGINT NOT NULL DEFAULT 0,
 last_active_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS growth_rewards (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, todo_id TEXT NOT NULL,
 kind TEXT NOT NULL,title TEXT NOT NULL,points BIGINT NOT NULL,active BIGINT NOT NULL,
 earned_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,version BIGINT NOT NULL,
 local_date TEXT NOT NULL,timezone TEXT NOT NULL,minutes BIGINT,
 PRIMARY KEY(user_id,todo_id)
);
CREATE INDEX IF NOT EXISTS growth_reward_week ON growth_rewards(user_id,local_date,active,earned_at);
CREATE TABLE IF NOT EXISTS growth_focus_days (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,local_date TEXT NOT NULL,
 todo_id TEXT NOT NULL,PRIMARY KEY(user_id,local_date)
);
CREATE TABLE IF NOT EXISTS growth_todo_actions (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,todo_id TEXT NOT NULL,
 replied BIGINT NOT NULL,actual_minutes BIGINT,updated_at BIGINT NOT NULL,PRIMARY KEY(user_id,todo_id)
);
CREATE TABLE IF NOT EXISTS growth_events (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 todo_id TEXT NOT NULL,event_kind TEXT NOT NULL,created_at BIGINT NOT NULL,body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS growth_commands (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,
 operation TEXT NOT NULL,fingerprint TEXT NOT NULL,response_body TEXT NOT NULL,
 todo_id TEXT NOT NULL DEFAULT '',created_at BIGINT NOT NULL,
 PRIMARY KEY(user_id,request_id)
);
CREATE TABLE IF NOT EXISTS growth_daily_plans (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 local_date TEXT NOT NULL,timezone TEXT NOT NULL,status TEXT NOT NULL,
 task_id TEXT,attempts BIGINT NOT NULL DEFAULT 0,dispatches BIGINT NOT NULL DEFAULT 0,model_attempt BIGINT,
 context TEXT NOT NULL DEFAULT '',error TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 UNIQUE(user_id,local_date)
);
CREATE TABLE IF NOT EXISTS growth_plan_items (
 id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES growth_daily_plans(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,todo_id TEXT,
 body TEXT NOT NULL,status TEXT NOT NULL,slot BIGINT NOT NULL,focus BIGINT NOT NULL,
 version BIGINT NOT NULL,created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS growth_plan_visible ON growth_plan_items(plan_id,user_id,slot,status);
CREATE TABLE IF NOT EXISTS growth_scheduler_state (
 id BIGINT PRIMARY KEY,after_user_id TEXT NOT NULL,guard BIGINT NOT NULL DEFAULT 0
);
