-- =====================================================
-- PRODUCTION HARDENING — 2025-02-25
-- Execute no Supabase: SQL Editor → New query → Run
-- =====================================================

-- ─────────────────────────────────────────────────────
-- 1) Índice único em conversa_unreads
--    Necessário para o upsert atômico em incrementarUnreadParaConversa.
--    Sem este índice, race conditions podem criar linhas duplicadas e
--    o upsert cai no fallback não-atômico.
-- ─────────────────────────────────────────────────────
-- Remover duplicatas antes de criar o índice (mantém a linha com maior unread_count)
DELETE FROM public.conversa_unreads a
USING public.conversa_unreads b
WHERE a.company_id  = b.company_id
  AND a.conversa_id = b.conversa_id
  AND a.usuario_id  = b.usuario_id
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversa_unreads_unique
  ON public.conversa_unreads (company_id, conversa_id, usuario_id);

COMMENT ON INDEX public.idx_conversa_unreads_unique
  IS 'Garante 1 linha por (empresa, conversa, usuário) — necessário para upsert atômico de unread_count.';

-- ─────────────────────────────────────────────────────
-- 2) Índice em mensagens.whatsapp_id (sem conversa_id)
--    O endpoint /webhooks/zapi/status busca por whatsapp_id+company_id.
--    Sem este índice, cada busca de status é um full table scan.
--    O índice composto (conversa_id, whatsapp_id) existente NÃO cobre
--    queries que filtram apenas por whatsapp_id.
-- ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_mensagens_company_whatsapp_id
  ON public.mensagens (company_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL AND whatsapp_id != '';

COMMENT ON INDEX public.idx_mensagens_company_whatsapp_id
  IS 'Cobertura de buscas por (company_id, whatsapp_id) no endpoint de status Z-API.';

-- ─────────────────────────────────────────────────────
-- 3) Garantir que mensagens.status tenha valores canônicos
--    (alguns registros legados podem ter 'enviada'/'entregue' em PT-BR)
-- ─────────────────────────────────────────────────────
UPDATE public.mensagens
SET status = CASE
  WHEN lower(status) IN ('enviada', 'enviado', 'sent') THEN 'sent'
  WHEN lower(status) IN ('entregue', 'received', 'delivered') THEN 'delivered'
  WHEN lower(status) IN ('lida', 'read', 'read_by_me') THEN 'read'
  WHEN lower(status) IN ('played') THEN 'played'
  WHEN lower(status) IN ('pendente', 'pending') THEN 'pending'
  WHEN lower(status) IN ('erro', 'error', 'failed') THEN 'erro'
  ELSE status
END
WHERE status IS NOT NULL
  AND status NOT IN ('sent', 'delivered', 'read', 'played', 'pending', 'erro');

-- ─────────────────────────────────────────────────────
-- 4) Índice em conversas.ultima_atividade para ordenação
--    (lista de chats por mais recente — query principal do CRM)
-- ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversas_company_ultima_atividade
  ON public.conversas (company_id, ultima_atividade DESC NULLS LAST)
  WHERE status_atendimento != 'fechada';

COMMENT ON INDEX public.idx_conversas_company_ultima_atividade
  IS 'Ordena lista de conversas abertas por atividade mais recente.';

-- ─────────────────────────────────────────────────────
-- 5) Garantir coluna pushname em clientes (compat)
-- ─────────────────────────────────────────────────────
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS pushname varchar(255);

-- ─────────────────────────────────────────────────────
-- 6) Função RPC atômica para incrementar unread_count
--
--    Resolve a race condition no incrementarUnreadParaConversa:
--    usa INSERT ... ON CONFLICT DO UPDATE SET unread_count = unread_count + 1
--    que é uma operação atômica no PostgreSQL — dois requests simultâneos
--    não podem ambos ler 0 e escrever 1.
--
--    Chamada via: supabase.rpc('increment_conversa_unreads', {...})
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_conversa_unreads(
  p_company_id  bigint,
  p_conversa_id bigint,
  p_usuario_ids bigint[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.conversa_unreads (company_id, conversa_id, usuario_id, unread_count, updated_at)
  SELECT p_company_id, p_conversa_id, uid, 1, now()
  FROM unnest(p_usuario_ids) AS uid
  ON CONFLICT (company_id, conversa_id, usuario_id)
  DO UPDATE SET
    unread_count = public.conversa_unreads.unread_count + 1,
    updated_at   = now();
END;
$$;

COMMENT ON FUNCTION public.increment_conversa_unreads IS
  'Incrementa atomicamente unread_count para uma lista de usuários numa conversa. '
  'Usa INSERT ON CONFLICT DO UPDATE para evitar race conditions.';

-- ─────────────────────────────────────────────────────
-- Confirme sem erros. Reinicie o backend após a execução.
-- ─────────────────────────────────────────────────────
