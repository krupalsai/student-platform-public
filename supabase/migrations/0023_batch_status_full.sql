-- Adds a 'full' batch status, set automatically once a batch's enrolled
-- count reaches its configured batch_limit. A 'full' batch is excluded
-- from the active-batch registration lookup in /api/profile the same way
-- paused/closed/archived already are, so it naturally stops accepting new
-- registrations without any change needed to that existing query.
ALTER TYPE batch_status ADD VALUE IF NOT EXISTS 'full';
