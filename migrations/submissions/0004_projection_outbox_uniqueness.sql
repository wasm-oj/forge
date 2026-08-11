CREATE UNIQUE INDEX submission_projection_outbox_unique
ON submission_outbox(submission_id, kind)
WHERE kind IN ('update-profile', 'update-leaderboard', 'update-contest');
