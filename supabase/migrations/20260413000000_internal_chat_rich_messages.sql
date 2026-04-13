-- ============================================================
-- Chat interno — tipos ricos: mídia, localização, contato, etc.
-- (isolado do WhatsApp; sem webhooks)
-- ============================================================

ALTER TABLE public.internal_messages
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS mime_type varchar(200),
  ADD COLUMN IF NOT EXISTS file_size bigint,
  ADD COLUMN IF NOT EXISTS payload jsonb;

ALTER TABLE public.internal_messages
  ALTER COLUMN content SET DEFAULT '';

ALTER TABLE public.internal_messages
  ALTER COLUMN message_type TYPE varchar(32);

ALTER TABLE public.internal_messages
  DROP CONSTRAINT IF EXISTS internal_messages_type_chk;

ALTER TABLE public.internal_messages
  DROP CONSTRAINT IF EXISTS internal_messages_content_nonempty_chk;

ALTER TABLE public.internal_messages
  DROP CONSTRAINT IF EXISTS internal_messages_body_chk;

ALTER TABLE public.internal_messages
  ADD CONSTRAINT internal_messages_type_chk
  CHECK (message_type IN (
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'contact',
    'sticker'
  ));

-- Texto: conteúdo obrigatório. Mídia: URL obrigatória + legenda opcional (até 8000).
-- Localização / contato: payload JSON obrigatório com campos mínimos.
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
      AND (payload ? 'name')
      AND (payload ? 'phone')
      AND char_length(btrim(coalesce(payload->>'name', ''))) >= 1
      AND char_length(btrim(coalesce(payload->>'phone', ''))) >= 1
    )
  );

COMMENT ON COLUMN public.internal_messages.media_url IS 'URL relativa /uploads/... ou absoluta controlada pelo backend.';
COMMENT ON COLUMN public.internal_messages.payload IS 'Metadados: localização {latitude, longitude, address?}, contato {name, phone, organization?}, etc.';

-- ============================================================
-- Listagem: incluir tipo e mídia da última mensagem
-- (DROP obrigatório: PG não permite CREATE OR REPLACE alterando RETURNS TABLE)
-- ============================================================
DROP FUNCTION IF EXISTS public.internal_chat_list_conversations(integer, integer);

CREATE FUNCTION public.internal_chat_list_conversations(
  p_company_id integer,
  p_user_id integer
)
RETURNS TABLE (
  conversation_id bigint,
  participant_pair_key varchar,
  last_message_at timestamptz,
  updated_at timestamptz,
  peer_id integer,
  peer_nome varchar,
  peer_email varchar,
  last_message_id bigint,
  last_message_content text,
  last_message_type varchar,
  last_message_media_url text,
  last_message_sender_id integer,
  last_message_created_at timestamptz,
  last_message_is_deleted boolean,
  unread_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH my_part AS (
    SELECT icp.conversation_id
    FROM public.internal_conversation_participants icp
    WHERE icp.company_id = p_company_id
      AND icp.user_id = p_user_id
  ),
  base AS (
    SELECT ic.*
    FROM public.internal_conversations ic
    INNER JOIN my_part mp ON mp.conversation_id = ic.id
    WHERE ic.company_id = p_company_id
  ),
  peer AS (
    SELECT p.conversation_id,
      p.user_id AS peer_id
    FROM public.internal_conversation_participants p
    INNER JOIN base b ON b.id = p.conversation_id
    WHERE p.company_id = p_company_id
      AND p.user_id <> p_user_id
  ),
  last_msg AS (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id,
      m.id AS lm_id,
      m.content AS lm_content,
      m.message_type AS lm_type,
      m.media_url AS lm_media_url,
      m.sender_user_id AS lm_sender_id,
      m.created_at AS lm_created_at,
      m.is_deleted AS lm_is_deleted
    FROM public.internal_messages m
    INNER JOIN base b ON b.id = m.conversation_id
    WHERE m.company_id = p_company_id
    ORDER BY m.conversation_id, m.id DESC
  ),
  reads AS (
    SELECT r.conversation_id, r.last_read_message_id
    FROM public.internal_conversation_reads r
    WHERE r.user_id = p_user_id
  )
  SELECT
    b.id AS conversation_id,
    b.participant_pair_key,
    b.last_message_at,
    b.updated_at,
    pr.peer_id,
    u.nome AS peer_nome,
    u.email AS peer_email,
    lm.lm_id AS last_message_id,
    lm.lm_content AS last_message_content,
    lm.lm_type AS last_message_type,
    lm.lm_media_url AS last_message_media_url,
    lm.lm_sender_id AS last_message_sender_id,
    lm.lm_created_at AS last_message_created_at,
    COALESCE(lm.lm_is_deleted, false) AS last_message_is_deleted,
    (
      SELECT COUNT(*)::bigint
      FROM public.internal_messages m2
      WHERE m2.conversation_id = b.id
        AND m2.company_id = p_company_id
        AND m2.is_deleted = false
        AND m2.sender_user_id IS DISTINCT FROM p_user_id
        AND (
          r.last_read_message_id IS NULL
          OR m2.id > r.last_read_message_id
        )
    ) AS unread_count
  FROM base b
  LEFT JOIN peer pr ON pr.conversation_id = b.id
  LEFT JOIN public.usuarios u ON u.id = pr.peer_id AND u.company_id = p_company_id
  LEFT JOIN last_msg lm ON lm.conversation_id = b.id
  LEFT JOIN reads r ON r.conversation_id = b.id
  ORDER BY COALESCE(b.last_message_at, b.updated_at, b.created_at) DESC NULLS LAST;
$$;

COMMENT ON FUNCTION public.internal_chat_list_conversations(integer, integer) IS
  'Lista conversas internas com peer, última mensagem (tipo + mídia) e não lidas.';
