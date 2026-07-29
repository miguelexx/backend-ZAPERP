-- ============================================================
-- ZapERP — Chat interno (1:1), isolado do WhatsApp
-- Tabelas: internal_conversations, internal_conversation_participants,
--          internal_messages, internal_conversation_reads
-- ============================================================

-- 1) Conversas internas (sem provider/jid/webhook)
CREATE TABLE IF NOT EXISTS public.internal_conversations (
  id                    bigserial PRIMARY KEY,
  company_id            integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  participant_pair_key  varchar(64) NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_message_at       timestamptz NULL,

  CONSTRAINT internal_conversations_company_pair_uq
    UNIQUE (company_id, participant_pair_key),

  CONSTRAINT internal_conversations_pair_key_format_chk
    CHECK (participant_pair_key ~ '^[0-9]+:[0-9]+$')
);

COMMENT ON TABLE public.internal_conversations IS 'Conversas internas entre funcionários (1:1). Isolado de conversas/mensagens WhatsApp.';
COMMENT ON COLUMN public.internal_conversations.participant_pair_key IS 'Par canônico menorId:maiorId (usuarios.id). Único por empresa para evitar duplicidade em concorrência.';

CREATE INDEX IF NOT EXISTS idx_internal_conversations_company_last_msg
  ON public.internal_conversations (company_id, last_message_at DESC NULLS LAST);

-- 2) Participantes (exatamente 2 por conversa 1:1)
CREATE TABLE IF NOT EXISTS public.internal_conversation_participants (
  id               bigserial PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES public.internal_conversations(id) ON DELETE CASCADE,
  user_id          integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  company_id       integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT internal_conv_participants_conv_user_uq UNIQUE (conversation_id, user_id)
);

COMMENT ON TABLE public.internal_conversation_participants IS 'Participantes de chat interno; conversa 1:1 possui exatamente 2 linhas.';

CREATE INDEX IF NOT EXISTS idx_internal_conv_participants_conversation
  ON public.internal_conversation_participants (conversation_id);
CREATE INDEX IF NOT EXISTS idx_internal_conv_participants_user
  ON public.internal_conversation_participants (user_id);
CREATE INDEX IF NOT EXISTS idx_internal_conv_participants_company
  ON public.internal_conversation_participants (company_id);
CREATE INDEX IF NOT EXISTS idx_internal_conv_participants_company_user
  ON public.internal_conversation_participants (company_id, user_id);

-- 3) Mensagens internas (somente texto nesta fase)
CREATE TABLE IF NOT EXISTS public.internal_messages (
  id                bigserial PRIMARY KEY,
  conversation_id   bigint NOT NULL REFERENCES public.internal_conversations(id) ON DELETE CASCADE,
  company_id        integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  sender_user_id    integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  message_type      varchar(20) NOT NULL DEFAULT 'text',
  content           text NOT NULL,
  is_deleted        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT internal_messages_type_chk
    CHECK (message_type = 'text'),

  CONSTRAINT internal_messages_content_nonempty_chk
    CHECK (char_length(btrim(content)) >= 1 AND char_length(content) <= 8000)
);

COMMENT ON TABLE public.internal_messages IS 'Mensagens de chat interno; não integra com WhatsApp.';
COMMENT ON COLUMN public.internal_messages.is_deleted IS 'Soft delete lógico; registro permanece para auditoria.';

CREATE INDEX IF NOT EXISTS idx_internal_messages_conversation_created
  ON public.internal_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_messages_company_created
  ON public.internal_messages (company_id, created_at DESC);

-- 4) Leitura por usuário (contadores / última lida)
CREATE TABLE IF NOT EXISTS public.internal_conversation_reads (
  id                     bigserial PRIMARY KEY,
  conversation_id        bigint NOT NULL REFERENCES public.internal_conversations(id) ON DELETE CASCADE,
  user_id                integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  last_read_message_id   bigint NULL REFERENCES public.internal_messages(id) ON DELETE SET NULL,
  last_read_at           timestamptz NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT internal_conversation_reads_conv_user_uq UNIQUE (conversation_id, user_id)
);

COMMENT ON TABLE public.internal_conversation_reads IS 'Estado de leitura por usuário em conversa interna (ex.: não lidas).';

CREATE INDEX IF NOT EXISTS idx_internal_reads_conversation
  ON public.internal_conversation_reads (conversation_id);
CREATE INDEX IF NOT EXISTS idx_internal_reads_user
  ON public.internal_conversation_reads (user_id);
CREATE INDEX IF NOT EXISTS idx_internal_reads_company_user
  ON public.internal_conversation_reads (conversation_id, user_id);

-- ============================================================
-- Validação de participant_pair_key (menor:maior, ambos > 0)
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_conversations_validate_pair_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  a bigint;
  b bigint;
BEGIN
  IF NEW.participant_pair_key IS NULL OR btrim(NEW.participant_pair_key) = '' THEN
    RAISE EXCEPTION 'participant_pair_key obrigatório';
  END IF;

  IF NEW.participant_pair_key !~ '^[0-9]+:[0-9]+$' THEN
    RAISE EXCEPTION 'participant_pair_key inválido (use menorId:maiorId)';
  END IF;

  a := split_part(NEW.participant_pair_key, ':', 1)::bigint;
  b := split_part(NEW.participant_pair_key, ':', 2)::bigint;

  IF a <= 0 OR b <= 0 OR a >= b THEN
    RAISE EXCEPTION 'participant_pair_key deve ser dois usuários distintos ordenados (menor:maior)';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS internal_conversations_validate_pair_key_trg ON public.internal_conversations;
CREATE TRIGGER internal_conversations_validate_pair_key_trg
  BEFORE INSERT OR UPDATE OF participant_pair_key ON public.internal_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_conversations_validate_pair_key();

-- ============================================================
-- Participantes: máximo 2, empresa alinhada, usuário no par, usuário na empresa
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_conversation_participants_before_ins_upd()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conv_company integer;
  pk text;
  a int;
  b int;
  u_company integer;
  cnt int;
BEGIN
  SELECT company_id, participant_pair_key
    INTO conv_company, pk
  FROM public.internal_conversations
  WHERE id = NEW.conversation_id;

  IF conv_company IS NULL THEN
    RAISE EXCEPTION 'Conversa interna não encontrada';
  END IF;

  IF NEW.company_id IS DISTINCT FROM conv_company THEN
    RAISE EXCEPTION 'company_id do participante diverge da conversa';
  END IF;

  a := split_part(pk, ':', 1)::int;
  b := split_part(pk, ':', 2)::int;

  IF NEW.user_id NOT IN (a, b) THEN
    RAISE EXCEPTION 'user_id fora do par canônico desta conversa';
  END IF;

  SELECT company_id INTO u_company FROM public.usuarios WHERE id = NEW.user_id;
  IF u_company IS NULL OR u_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Usuário não pertence à empresa informada';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT COUNT(*) INTO cnt
    FROM public.internal_conversation_participants
    WHERE conversation_id = NEW.conversation_id;

    IF cnt >= 2 THEN
      RAISE EXCEPTION 'Conversa 1:1 já possui 2 participantes';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS internal_conversation_participants_before_ins_trg
  ON public.internal_conversation_participants;
CREATE TRIGGER internal_conversation_participants_before_ins_trg
  BEFORE INSERT ON public.internal_conversation_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_conversation_participants_before_ins_upd();

-- UPDATE de company_id/user_id/conversation_id raro; ainda assim revalidar
DROP TRIGGER IF EXISTS internal_conversation_participants_before_upd_trg
  ON public.internal_conversation_participants;
CREATE TRIGGER internal_conversation_participants_before_upd_trg
  BEFORE UPDATE OF conversation_id, user_id, company_id ON public.internal_conversation_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_conversation_participants_before_ins_upd();

-- Após 2 participantes, garantir que são exatamente os ids do par
CREATE OR REPLACE FUNCTION public.internal_conversation_participants_after_pair_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pk text;
  a int;
  b int;
  u1 int;
  u2 int;
  n int;
  cid bigint;
BEGIN
  cid := COALESCE(NEW.conversation_id, OLD.conversation_id);

  SELECT participant_pair_key INTO pk
  FROM public.internal_conversations
  WHERE id = cid;

  IF pk IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  a := split_part(pk, ':', 1)::int;
  b := split_part(pk, ':', 2)::int;

  SELECT COUNT(*)::int INTO n
  FROM public.internal_conversation_participants
  WHERE conversation_id = cid;

  IF n = 2 THEN
    SELECT p1.user_id, p2.user_id
      INTO u1, u2
    FROM public.internal_conversation_participants p1
    INNER JOIN public.internal_conversation_participants p2
      ON p2.conversation_id = p1.conversation_id AND p2.id <> p1.id AND p2.user_id > p1.user_id
    WHERE p1.conversation_id = cid
    LIMIT 1;

    IF u1 IS NULL OR u2 IS NULL THEN
      RAISE EXCEPTION 'Participantes inconsistentes na conversa';
    END IF;

    IF u1 <> a OR u2 <> b THEN
      RAISE EXCEPTION 'Participantes não correspondem ao participant_pair_key';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS internal_conversation_participants_after_pair_check_trg
  ON public.internal_conversation_participants;
CREATE TRIGGER internal_conversation_participants_after_pair_check_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.internal_conversation_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_conversation_participants_after_pair_check();

-- ============================================================
-- Mensagens: alinhar company_id e remetente participante
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_messages_before_ins_upd()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conv_company integer;
  pk text;
  a int;
  b int;
BEGIN
  SELECT company_id, participant_pair_key
    INTO conv_company, pk
  FROM public.internal_conversations
  WHERE id = NEW.conversation_id;

  IF conv_company IS NULL THEN
    RAISE EXCEPTION 'Conversa interna não encontrada';
  END IF;

  IF NEW.company_id IS DISTINCT FROM conv_company THEN
    RAISE EXCEPTION 'company_id da mensagem diverge da conversa';
  END IF;

  a := split_part(pk, ':', 1)::int;
  b := split_part(pk, ':', 2)::int;

  IF NEW.sender_user_id NOT IN (a, b) THEN
    RAISE EXCEPTION 'Remetente deve ser participante da conversa';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE u.id = NEW.sender_user_id AND u.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Remetente não pertence à empresa da mensagem';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS internal_messages_before_ins_trg ON public.internal_messages;
CREATE TRIGGER internal_messages_before_ins_trg
  BEFORE INSERT ON public.internal_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_messages_before_ins_upd();

DROP TRIGGER IF EXISTS internal_messages_before_upd_trg ON public.internal_messages;
CREATE TRIGGER internal_messages_before_upd_trg
  BEFORE UPDATE OF conversation_id, company_id, sender_user_id ON public.internal_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_messages_before_ins_upd();

-- Atualiza last_message_at na conversa
CREATE OR REPLACE FUNCTION public.internal_messages_after_touch_conversation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.internal_conversations
  SET
    last_message_at = NEW.created_at,
    updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS internal_messages_after_ins_touch_conv_trg ON public.internal_messages;
CREATE TRIGGER internal_messages_after_ins_touch_conv_trg
  AFTER INSERT ON public.internal_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_messages_after_touch_conversation();

-- ============================================================
-- Leituras: conversation/user coerentes; last_read_message na mesma conversa
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_conversation_reads_before_ins_upd()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conv_company integer;
  msg_conv bigint;
  msg_company integer;
BEGIN
  SELECT company_id INTO conv_company
  FROM public.internal_conversations
  WHERE id = NEW.conversation_id;

  IF conv_company IS NULL THEN
    RAISE EXCEPTION 'Conversa interna não encontrada';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE u.id = NEW.user_id AND u.company_id = conv_company
  ) THEN
    RAISE EXCEPTION 'Usuário não pertence à empresa da conversa';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.internal_conversation_participants p
    WHERE p.conversation_id = NEW.conversation_id AND p.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Somente participantes podem ter registro de leitura';
  END IF;

  IF NEW.last_read_message_id IS NOT NULL THEN
    SELECT conversation_id, company_id INTO msg_conv, msg_company
    FROM public.internal_messages
    WHERE id = NEW.last_read_message_id;

    IF msg_conv IS NULL THEN
      RAISE EXCEPTION 'last_read_message_id inválido';
    END IF;

    IF msg_conv IS DISTINCT FROM NEW.conversation_id OR msg_company IS DISTINCT FROM conv_company THEN
      RAISE EXCEPTION 'last_read_message_id não pertence a esta conversa/empresa';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS internal_conversation_reads_before_ins_trg ON public.internal_conversation_reads;
CREATE TRIGGER internal_conversation_reads_before_ins_trg
  BEFORE INSERT ON public.internal_conversation_reads
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_conversation_reads_before_ins_upd();

DROP TRIGGER IF EXISTS internal_conversation_reads_before_upd_trg ON public.internal_conversation_reads;
CREATE TRIGGER internal_conversation_reads_before_upd_trg
  BEFORE UPDATE OF conversation_id, user_id, last_read_message_id ON public.internal_conversation_reads
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_conversation_reads_before_ins_upd();

-- ============================================================
-- updated_at automático
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_chat_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS internal_conversations_touch_updated_at_trg ON public.internal_conversations;
CREATE TRIGGER internal_conversations_touch_updated_at_trg
  BEFORE UPDATE ON public.internal_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_chat_touch_updated_at();

DROP TRIGGER IF EXISTS internal_messages_touch_updated_at_trg ON public.internal_messages;
CREATE TRIGGER internal_messages_touch_updated_at_trg
  BEFORE UPDATE ON public.internal_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_chat_touch_updated_at();

DROP TRIGGER IF EXISTS internal_conversation_reads_touch_updated_at_trg ON public.internal_conversation_reads;
CREATE TRIGGER internal_conversation_reads_touch_updated_at_trg
  BEFORE UPDATE ON public.internal_conversation_reads
  FOR EACH ROW
  EXECUTE FUNCTION public.internal_chat_touch_updated_at();

-- ============================================================
-- Criação atômica de conversa 1:1 + participantes (anti corrida)
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_chat_ensure_pair_conversation(
  p_company_id integer,
  p_user_a integer,
  p_user_b integer
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  lo int;
  hi int;
  pair text;
  conv_id bigint;
  ca int;
  cb int;
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

  SELECT company_id INTO ca FROM public.usuarios WHERE id = lo;
  SELECT company_id INTO cb FROM public.usuarios WHERE id = hi;

  IF ca IS NULL OR cb IS NULL THEN
    RAISE EXCEPTION 'Usuário não encontrado';
  END IF;

  IF ca IS DISTINCT FROM p_company_id OR cb IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Ambos os usuários devem pertencer à mesma empresa';
  END IF;

  INSERT INTO public.internal_conversations (company_id, participant_pair_key)
  VALUES (p_company_id, pair)
  ON CONFLICT (company_id, participant_pair_key) DO NOTHING;

  SELECT id INTO conv_id
  FROM public.internal_conversations
  WHERE company_id = p_company_id AND participant_pair_key = pair
  LIMIT 1;

  IF conv_id IS NULL THEN
    RAISE EXCEPTION 'Falha ao resolver conversa interna';
  END IF;

  INSERT INTO public.internal_conversation_participants (conversation_id, user_id, company_id)
  VALUES (conv_id, lo, p_company_id)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  INSERT INTO public.internal_conversation_participants (conversation_id, user_id, company_id)
  VALUES (conv_id, hi, p_company_id)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  RETURN conv_id;
END;
$$;

COMMENT ON FUNCTION public.internal_chat_ensure_pair_conversation(integer, integer, integer) IS
  'Garante conversa 1:1 interna entre dois usuários da mesma empresa; idempotente sob concorrência.';
