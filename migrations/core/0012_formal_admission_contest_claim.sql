ALTER TABLE formal_submission_admissions ADD COLUMN contest_id TEXT REFERENCES contests(id);
ALTER TABLE formal_submission_admissions ADD COLUMN admitted_at TEXT;

CREATE INDEX formal_submission_admissions_contest_admitted
ON formal_submission_admissions(contest_id, admitted_at)
WHERE contest_id IS NOT NULL;
