CREATE UNIQUE INDEX organizer_applications_one_pending
ON organizer_applications(user_id)
WHERE status = 'pending';
