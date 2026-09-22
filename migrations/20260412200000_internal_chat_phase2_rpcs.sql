-- ============================================================
-- Chat interno — fase 2: RPC de listagem + retorno meta em ensure_pair
-- ============================================================

-- Troca retorno de bigint -> jsonb (PostgREST devolve objeto ao cliente)
DROP FUNCTION IF EXISTS public.internal_chat_ensure_pair_conversation(integer, integer, integer);

CREATE OR REPLACE FUNCTION public.internal_chat_ensure_pair_conversation(
  p_company_id integer,
  p_user_a integer,
  p_user_b integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  lo int;
  hi int;
  pair text;
  conv_id bigint;
  new_id bigint;
  ca int;
  cb int;
  active_lo boolean;
  active_hi boolean;
  created_row boolean := false;
BEGIN
  IF p_company_id IS NULL OR p_company_id <= 0 THEN
    RAISE EXCEPTION 'company_id inválido';
  END IF;

  IF p_user_a IS NULL OR p_user_b IS NULL OR p_user_a = p_user_b THEN
    RAISE EXCEPTION 'Conversa interna requer dois usuários distintos';
  END IF;

  IF p_user_a < p_user_b THEN
    lo := p_user_a; hi := p_user_b;
  ELSE
    lo := p_user_b; hi := p_user_a;
  END IF;

  pair := lo::text || ':' || hi::text;

  SELECT company_id, COALESCE(ativo, true)
    INTO ca, active_lo
  FROM public.usuarios
  WHERE id = lo;

  SELECT company_id, COALESCE(ativo, true)
    INTO cb, active_hi
  FROM public.usuarios
  WHERE id = hi;

  IF ca IS NULL OR cb IS NULL THEN
    RAISE EXCEPTION 'Usuário não encontrado';
  END IF;

  IF ca IS DISTINCT FROM p_company_id OR cb IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Ambos os usuários devem pertencer à mesma empresa';
  END IF;

  IF active_lo IS NOT TRUE OR active_hi IS NOT TRUE THEN
    RAISE EXCEPTION 'Usuário inativo ou indisponível para chat interno';
  END IF;

  INSERT INTO public.internal_conversations (company_id, participant_pair_key)
  VALUES (p_company_id, pair)
  ON CONFLICT (company_id, participant_pair_key) DO NOTHING
  RETURNING id INTO new_id;

  IF new_id IS NOT NULL THEN
    conv_id := new_id;
    created_row := true;
  ELSE
    SELECT ic.id INTO conv_id
    FROM public.internal_conversations ic
    WHERE ic.company_id = p_company_id
      AND ic.participant_pair_key = pair
    LIMIT 1;
    created_row := false;
  END IF;

  IF conv_id IS NULL THEN
    RAISE EXCEPTION 'Falha ao resolver conversa interna';
  END IF;

  INSERT INTO public.internal_conversation_participants (conversation_id, user_id, company_id)
  VALUES (conv_id, lo, p_company_id)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  INSERT INTO public.internal_conversation_participants (conversation_id, user_id, company_id)
  VALUES (conv_id, hi, p_company_id)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  RETURN jsonb_build_object(
    'conversation_id', conv_id,
    'created', created_row
  );
END;
$$;

COMMENT ON FUNCTION public.internal_chat_ensure_pair_conversation(integer, integer, integer) IS
  'Garante conversa 1:1 + participantes; retorna { conversation_id, created } (created=true só se a linha da conversa foi criada nesta chamada).';

-- Listagem agregada (sem N+1 no app)
CREATE OR REPLACE FUNCTION public.internal_chat_list_conversations(
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
  'Lista conversas internas do usuário com peer, última mensagem e contagem de não lidas.';
