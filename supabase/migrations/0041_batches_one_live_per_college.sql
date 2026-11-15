-- Separate from 0040 because ALTER TYPE ... ADD VALUE cannot safely be used
-- in the same transaction as code that depends on the new value existing.
CREATE UNIQUE INDEX batches_one_live_per_college
  ON batches(college) WHERE status IN ('active', 'pending_setup');
