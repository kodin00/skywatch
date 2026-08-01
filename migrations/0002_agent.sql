CREATE TABLE IF NOT EXISTS skywatch_agent_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  transport TEXT NOT NULL CHECK (transport IN ('vpc', 'direct')),
  endpoint TEXT NOT NULL,
  allow_insecure_http INTEGER NOT NULL DEFAULT 0 CHECK (allow_insecure_http IN (0, 1)),
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skywatch_agent_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  transport TEXT,
  node_id TEXT,
  container_id TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_skywatch_agent_audit_created_at
  ON skywatch_agent_audit(created_at);
