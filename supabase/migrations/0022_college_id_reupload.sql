-- One-time self-service re-upload of College ID, for students whose
-- earlier upload was missing the required signature. Once used, this
-- flag permanently locks the student-facing re-upload endpoint — only
-- an admin can change the ID after that (via the existing Docs sheet).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS college_id_reupload_used BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS college_id_reupload_used_at TIMESTAMPTZ;
