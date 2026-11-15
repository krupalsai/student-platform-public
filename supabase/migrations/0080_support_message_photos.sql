-- Migration 0080: let a Contact Support chat message (student_query_messages)
-- carry an actual photo, not just a text description of one.
--
-- WHY: item #194 wired photo understanding into the /support chat by
-- folding the AI's description into the message TEXT — the student's own
-- sent photo never actually rendered as an image in their own chat bubble,
-- only its description did. Live-reported ("tell when we upload the photo
-- how uh see that") as exactly that gap. photo_url lets the frontend show
-- the real photo, WhatsApp-style; photo_description caches the already-run
-- vision analysis so a later message in the SAME thread can still see it
-- in conversation history without re-running the vision call.

ALTER TABLE student_query_messages ADD COLUMN IF NOT EXISTS photo_url         text;
ALTER TABLE student_query_messages ADD COLUMN IF NOT EXISTS photo_description text;
