CREATE TABLE IF NOT EXISTS skywatch_agents (
  node_id TEXT PRIMARY KEY,
  transport TEXT NOT NULL CHECK (transport IN ('vpc', 'direct')),
  endpoint TEXT NOT NULL,
  allow_insecure_http INTEGER NOT NULL DEFAULT 0 CHECK (allow_insecure_http IN (0, 1)),
  node_name TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skywatch_agent_migrations (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO skywatch_agents
  (node_id, transport, endpoint, allow_insecure_http, node_name, agent_version, key_id,
   key_ciphertext, key_iv, connected_at, updated_at)
SELECT node_id, transport, endpoint, allow_insecure_http, node_name, agent_version, key_id,
  key_ciphertext, key_iv, connected_at, updated_at
FROM skywatch_agent_config
WHERE id = 1
  AND NOT EXISTS (SELECT 1 FROM skywatch_agent_migrations WHERE id = 1);

INSERT OR IGNORE INTO skywatch_agent_migrations (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_skywatch_agents_name
  ON skywatch_agents(node_name COLLATE NOCASE, node_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skywatch_agents_single_vpc
  ON skywatch_agents(transport)
  WHERE transport = 'vpc';
