-- Migration 0066: add BIET as an active college
--
-- The colleges table (migration 0033) already drives every dropdown and
-- selection in the admin UI dynamically — Create Batch, analytics filters,
-- route map, etc. all read from it, no code changes needed there. This is
-- purely a data change, recorded as a migration for history. Applied
-- directly to prod via MCP.

INSERT INTO colleges (id, name, active) VALUES ('BIET', 'BIET', true)
ON CONFLICT (id) DO UPDATE SET active = true;
