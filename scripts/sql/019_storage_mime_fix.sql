-- The chat-media bucket restricted allowed_mime_types to image/* and video/*
-- (inherited from the fitness app). That silently broke two things:
--   1. Document sending, which uploads as application/octet-stream.
--   2. Encrypted media — ciphertext has no meaningful MIME type, so it also
--      uploads as application/octet-stream.
-- Both failed at upload with "mime type ... is not supported".
--
-- Access is already governed by the bucket's RLS policies (conversation
-- participants only), so the MIME allowlist was adding no security here.
update storage.buckets
set allowed_mime_types = null
where id = 'chat-media';
