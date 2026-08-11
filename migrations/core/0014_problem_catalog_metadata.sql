ALTER TABLE managed_problem_versions ADD COLUMN difficulty TEXT CHECK (difficulty IN ('easy', 'medium', 'hard'));
ALTER TABLE managed_problem_versions ADD COLUMN tags_json TEXT;
ALTER TABLE managed_problem_versions ADD COLUMN track_id TEXT;
ALTER TABLE managed_problem_versions ADD COLUMN track_json TEXT;

CREATE INDEX managed_problem_versions_snapshot_number
ON managed_problem_versions(snapshot_id, problem_number);
