-- Open-Question Queue clustering (Round 8 AI). Adds an embedding to unknown
-- questions so the admin queue can group semantically-similar pending
-- questions ("how much to pay?" / "what's the fee?" / "fee ela kattali") into
-- one cluster the admin answers once. Populated lazily by the app (and on
-- insert); NULL until then, in which case each question is its own cluster —
-- no clustering, but the queue still works.

ALTER TABLE unknown_questions ADD COLUMN IF NOT EXISTS embedding vector(768);
