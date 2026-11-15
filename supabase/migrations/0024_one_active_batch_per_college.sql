-- Enforces "only one active batch per college" at the database level.
-- Application code (batches PATCH/POST routes) demotes any sibling active
-- batch before activating a new one — this index is the safety net that
-- makes a double-active state impossible even if that logic is bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_batch_per_college
ON batches (college) WHERE status = 'active';
