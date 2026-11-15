-- Semantic FAQ search (Round 8 AI). Adds pgvector embeddings to FAQs so a
-- student's question matches an FAQ by MEANING, not just shared keywords, e.g.
-- "money got cut but nothing happened" → the "payment debited but not
-- reflected" FAQ, which trigram/keyword matching misses.
--
-- Embeddings are 768-dim (Gemini text-embedding-004). They are populated by
-- the application (on FAQ creation and via an admin reindex) — this migration
-- only adds the schema. If embeddings are never populated (no embedding key
-- configured), the column stays NULL and searchFaq() simply falls back to the
-- existing trigram/keyword search — no regression.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE faqs ADD COLUMN IF NOT EXISTS embedding vector(768);

-- HNSW cosine index for fast nearest-neighbour lookup. Cheap here (dozens of
-- FAQs) but future-proof.
CREATE INDEX IF NOT EXISTS faqs_embedding_hnsw_idx
  ON faqs USING hnsw (embedding vector_cosine_ops);

-- Nearest enabled FAQs to a query embedding, above a cosine-similarity
-- threshold. SECURITY INVOKER (default) — the service role that calls it can
-- already read faqs; search_path pinned per the project's hardening.
CREATE OR REPLACE FUNCTION match_faqs(
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
RETURNS TABLE (id uuid, category text, question text, answer text, similarity float)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT f.id, f.category, f.question, f.answer,
         1 - (f.embedding <=> query_embedding) AS similarity
  FROM faqs f
  WHERE f.enabled
    AND f.embedding IS NOT NULL
    AND 1 - (f.embedding <=> query_embedding) >= match_threshold
  ORDER BY f.embedding <=> query_embedding
  LIMIT match_count;
$$;

REVOKE ALL ON FUNCTION match_faqs(vector, float, int) FROM anon;
