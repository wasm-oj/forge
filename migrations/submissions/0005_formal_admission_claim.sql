ALTER TABLE submissions ADD COLUMN formal_admitted_at TEXT;
ALTER TABLE submissions ADD COLUMN formal_admission_claim_sha256 TEXT
  CHECK (formal_admission_claim_sha256 IS NULL OR length(formal_admission_claim_sha256) = 64);
