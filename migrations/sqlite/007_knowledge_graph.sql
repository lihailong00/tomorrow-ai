-- Portable SQL: this schema is applied by both SQLite and PostgreSQL.
CREATE TABLE IF NOT EXISTS knowledge_entities (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 kind TEXT NOT NULL,
 name TEXT NOT NULL,
 name_key TEXT NOT NULL,
 identity_key TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 UNIQUE(user_id, scope, kind, identity_key)
);
CREATE INDEX IF NOT EXISTS knowledge_entity_names
 ON knowledge_entities(user_id, scope, kind, name_key);
CREATE TABLE IF NOT EXISTS knowledge_episodes (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 memory_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 source_version BIGINT NOT NULL,
 source_body TEXT NOT NULL,
 extraction_hash TEXT NOT NULL,
 entity_map TEXT NOT NULL DEFAULT '{}',
 title TEXT NOT NULL,
 scope TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 UNIQUE(user_id, memory_id)
);
CREATE TABLE IF NOT EXISTS knowledge_facts (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 episode_id TEXT NOT NULL REFERENCES knowledge_episodes(id) ON DELETE CASCADE,
 subject_id TEXT NOT NULL REFERENCES knowledge_entities(id),
 relation TEXT NOT NULL,
 object_id TEXT NOT NULL REFERENCES knowledge_entities(id),
 status TEXT NOT NULL,
 quote TEXT NOT NULL,
 occurred_on TEXT NOT NULL DEFAULT '',
 created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_fact_subjects ON knowledge_facts(user_id, subject_id);
CREATE INDEX IF NOT EXISTS knowledge_fact_objects ON knowledge_facts(user_id, object_id);
CREATE INDEX IF NOT EXISTS knowledge_fact_episodes ON knowledge_facts(episode_id);
