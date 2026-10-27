-- Base schema is deliberately portable between SQLite demo and PostgreSQL.
-- Repository::connect applies the shared standard-SQL base schema first.
-- This OPTIONAL production template is NOT applied by the first-build runtime.
-- DO NOT apply RLS statements below to the current SQLx Any application role:
-- it enforces ownership through explicit user_id predicates, and does not yet
-- establish transaction-local app.user_id on every pooled connection.
-- Before enabling this second boundary: implement scoped transactions, use a
-- restricted non-owner API role, configure separate narrowly granted worker
-- policies, and test pool reuse. Never use SUPERUSER/BYPASSRLS for the API.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS memory_embeddings (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 embedding vector(1536),
 model TEXT NOT NULL,
 created_at BIGINT NOT NULL
);
-- Application queries enforce user_id. RLS below adds a second boundary when
-- production uses transaction-local app.user_id and a separate restricted role.
-- Worker pool must use its dedicated, narrowly granted worker role.
-- ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE task_events ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY resource_owner ON resources USING (user_id = current_setting('app.user_id', true));
-- CREATE POLICY task_owner ON tasks USING (user_id = current_setting('app.user_id', true));
-- CREATE POLICY schedule_owner ON schedules USING (user_id = current_setting('app.user_id', true));
-- CREATE POLICY event_owner ON task_events USING (user_id = current_setting('app.user_id', true));
-- CREATE POLICY embedding_owner ON memory_embeddings USING (user_id = current_setting('app.user_id', true));
