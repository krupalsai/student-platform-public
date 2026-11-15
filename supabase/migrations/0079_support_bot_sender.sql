-- Migration 0079: let the AI support bot post into the in-app Contact
-- Support thread as its own sender, distinct from the student and a human
-- admin.
--
-- WHY: student_query_messages.sender was CHECK'd to only ('student','admin')
-- since migration 0063 built the thread — there was never an automatic
-- replier, only a human admin (who, in practice, has no reply UI of their
-- own yet). Turning /support into a real
-- WhatsApp-style live chat means every student message gets an immediate
-- AI reply in the SAME thread, which needs a third sender value so the
-- frontend can render it distinctly from a genuine human admin reply.

ALTER TABLE student_query_messages DROP CONSTRAINT IF EXISTS student_query_messages_sender_check;
ALTER TABLE student_query_messages ADD CONSTRAINT student_query_messages_sender_check
  CHECK (sender IN ('student', 'admin', 'bot'));
