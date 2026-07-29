-- ============================================================
-- Chat interno — contato: permite payload.contacts[] (várias
-- linhas) além do legado name + phone na raiz do payload.
-- ============================================================

ALTER TABLE public.internal_messages
  DROP CONSTRAINT IF EXISTS internal_messages_body_chk;

ALTER TABLE public.internal_messages
  ADD CONSTRAINT internal_messages_body_chk
  CHECK (
    (
      message_type = 'text'
      AND char_length(btrim(content)) >= 1
      AND char_length(content) <= 8000
    )
    OR (
      message_type IN ('image', 'document', 'audio', 'video', 'sticker')
      AND media_url IS NOT NULL
      AND char_length(btrim(media_url)) >= 1
      AND char_length(btrim(coalesce(content, ''))) <= 8000
    )
    OR (
      message_type = 'location'
      AND payload IS NOT NULL
      AND (payload ? 'latitude')
      AND (payload ? 'longitude')
    )
    OR (
      message_type = 'contact'
      AND payload IS NOT NULL
      AND (
        (
          (payload ? 'name')
          AND (payload ? 'phone')
          AND char_length(btrim(coalesce(payload->>'name', ''))) >= 1
          AND char_length(btrim(coalesce(payload->>'phone', ''))) >= 1
        )
        OR (
          jsonb_typeof(payload->'contacts') = 'array'
          AND jsonb_array_length(payload->'contacts') >= 1
          AND jsonb_array_length(payload->'contacts') <= 50
        )
      )
    )
  );

COMMENT ON COLUMN public.internal_messages.payload IS
  'Contato: legado {name, phone, organization?} ou {contacts: [{name, phone, organization?}, ...]}. Localização: {latitude, longitude, address?}.';
