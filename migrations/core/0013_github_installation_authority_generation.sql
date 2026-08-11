ALTER TABLE github_installations ADD COLUMN authority_generation INTEGER NOT NULL DEFAULT 0
  CHECK (authority_generation >= 0);
