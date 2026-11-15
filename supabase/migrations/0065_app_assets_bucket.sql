-- Migration 0065: app-assets storage bucket + service_role policy
--
-- POST /api/admin/settings/icon (Save Icon on the admin Settings page) has
-- been failing with a generic "Internal server error" since it was built —
-- it uploads to storage.from("app-assets"), but that bucket never existed.
-- Every other bucket this project uses (payment-screenshots,
-- student-documents, batch-exports) has a matching service_role RLS policy
-- (migration 0018) scoped to that bucket only — service_role is NOT given a
-- blanket bypass here, by design, so a new bucket needs its own policy or
-- service_role's own uploads are blocked by RLS same as anyone else's.
--
-- Public (unlike the other three): this bucket only ever holds the PWA
-- install icon, served unauthenticated to anyone installing the Student App
-- — there is nothing student-specific or private in it.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('app-assets', 'app-assets', true, 1048576, ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS service_role_all_app_assets ON storage.objects;
CREATE POLICY service_role_all_app_assets ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'app-assets')
  WITH CHECK (bucket_id = 'app-assets');
