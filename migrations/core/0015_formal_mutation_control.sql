CREATE TABLE formal_mutation_controls (
  environment TEXT PRIMARY KEY CHECK (environment IN ('development', 'staging', 'production')),
  formal_mutations_enabled INTEGER NOT NULL CHECK (formal_mutations_enabled IN (0, 1)),
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO formal_mutation_controls (environment, formal_mutations_enabled, reason, updated_at) VALUES
  ('development', 1, 'development-default-open', '1970-01-01T00:00:00.000Z'),
  ('staging', 0, 'deployment-default-closed', '1970-01-01T00:00:00.000Z'),
  ('production', 0, 'deployment-default-closed', '1970-01-01T00:00:00.000Z');
