-- Contact Support needs to behave differently from Ask a Question: always
-- escalate straight to admin, never try an FAQ auto-answer first, and show
-- the student nothing but "an admin will follow up." Both menu items
-- previously converged on the same generic "type your message" handling,
-- so there was no way to tell which prompt a following free-text reply was
-- answering. This one boolean is the minimum needed to distinguish them —
-- set true when Contact Support is tapped, read and cleared on the
-- student's next message.
ALTER TABLE whatsapp_moderation ADD COLUMN IF NOT EXISTS awaiting_support_message boolean NOT NULL DEFAULT false;
