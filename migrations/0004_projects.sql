CREATE TABLE IF NOT EXISTS skywatch_credentials (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skywatch_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('compose', 'github', 'image', 'script')),
  source_config TEXT NOT NULL,
  env_ciphertext TEXT,
  env_iv TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skywatch_deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES skywatch_projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('vps', 'cloudflare')),
  target_server_id TEXT,
  target_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'failed', 'removed')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_skywatch_deployments_project
  ON skywatch_deployments(project_id, created_at DESC);
