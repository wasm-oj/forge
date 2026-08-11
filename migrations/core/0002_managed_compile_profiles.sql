ALTER TABLE managed_problem_versions ADD COLUMN allowed_languages_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE managed_problem_versions ADD COLUMN compile_profiles_json TEXT NOT NULL DEFAULT '{}';
