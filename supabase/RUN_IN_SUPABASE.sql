-- ============================================================
-- Execute este script no Supabase: SQL Editor → New query → Run
-- IMPORTANTE: Cole e execute TUDO de uma vez (do início ao fim).
-- ============================================================

-- PRIMEIRO: remover constraint antiga que causa erro 23505 (duplicata em clientes)
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_telefone_unique;

-- 1) Coluna ultima_atividade em conversas (obrigatória para webhook Z-API)
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS ultima_atividade timestamp with time zone DEFAULT now();

COMMENT ON COLUMN public.conversas.ultima_atividade IS 'Última atividade na conversa (nova mensagem ou envio). Usado para ordenar a lista.';

-- Preencher conversas existentes
UPDATE public.conversas c
SET ultima_atividade = COALESCE(
  (SELECT max(m.criado_em) FROM public.mensagens m WHERE m.conversa_id = c.id),
  c.criado_em
)
WHERE c.ultima_atividade IS NULL;

-- 2) Colunas de mídia em mensagens (imagem, áudio, vídeo, documento, sticker)
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS tipo varchar(20) DEFAULT 'texto',
  ADD COLUMN IF NOT EXISTS url text,
  ADD COLUMN IF NOT EXISTS nome_arquivo text;

-- 3) Grupos: remetente na mensagem
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS remetente_nome varchar(255),
  ADD COLUMN IF NOT EXISTS remetente_telefone varchar(50);

-- 3b) Responder mensagens (citação estilo WhatsApp) — metadata persistida no banco
-- Usado pelo frontend para exibir o "bloco de resposta" dentro da bolha.
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS reply_meta jsonb;

COMMENT ON COLUMN public.mensagens.reply_meta IS 'Metadados de resposta: { name, snippet, ts, replyToId }.';

-- 4) Conversas: tipo grupo, nome_grupo, foto_grupo
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'cliente',
  ADD COLUMN IF NOT EXISTS nome_grupo text,
  ADD COLUMN IF NOT EXISTS foto_grupo text;

-- 5) Clientes: foto de perfil
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS foto_perfil text;

-- 6) Mensagens: id do WhatsApp (evitar duplicata) e status
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS whatsapp_id character varying;

-- Índice único para não duplicar mensagens pelo mesmo whatsapp_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_conversa_whatsapp_id
  ON public.mensagens (conversa_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL AND whatsapp_id != '';

-- ============================================================
-- SEM DUPLICATAS: clientes e conversas (um número = um cliente)
-- Usa coluna temporária para não violar clientes_telefone_unique durante o processo.
-- ============================================================

-- Garantir que todos os clientes tenham company_id (quem está NULL vira 1)
UPDATE public.clientes SET company_id = 1 WHERE company_id IS NULL;

-- Coluna temporária: normalizar aqui primeiro (não mexe em telefone, evita 23505)
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS telefone_norm text;

UPDATE public.clientes c
SET telefone_norm = (
  CASE
    WHEN trim(regexp_replace(c.telefone, '\D', '', 'g')) = '' THEN c.telefone
    WHEN length(regexp_replace(c.telefone, '\D', '', 'g')) IN (10, 11)
      THEN '55' || regexp_replace(c.telefone, '\D', '', 'g')
    WHEN regexp_replace(c.telefone, '\D', '', 'g') ~ '^55'
      THEN left(regexp_replace(c.telefone, '\D', '', 'g'), 13)
    ELSE left(regexp_replace(c.telefone, '\D', '', 'g'), 13)
  END
)
WHERE c.telefone IS NOT NULL AND c.telefone != '';

-- Apontar conversas para o cliente canônico (menor id por company_id + telefone_norm)
UPDATE public.conversas conv
SET cliente_id = (
  SELECT min(cl.id) FROM public.clientes cl
  WHERE cl.company_id = (SELECT company_id FROM public.clientes WHERE id = conv.cliente_id)
    AND cl.telefone_norm = (SELECT telefone_norm FROM public.clientes WHERE id = conv.cliente_id)
)
WHERE conv.cliente_id IS NOT NULL
  AND conv.cliente_id != (
    SELECT min(cl.id) FROM public.clientes cl
    WHERE cl.company_id = (SELECT company_id FROM public.clientes WHERE id = conv.cliente_id)
      AND cl.telefone_norm = (SELECT telefone_norm FROM public.clientes WHERE id = conv.cliente_id)
  );

-- Remover clientes duplicados (mantém o de menor id por company_id + telefone_norm)
DELETE FROM public.clientes a
USING public.clientes b
WHERE a.company_id = b.company_id AND a.telefone_norm = b.telefone_norm AND a.id > b.id;

-- Agora sim: remover constraint antiga e copiar telefone_norm para telefone
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_telefone_unique;

UPDATE public.clientes
SET telefone = telefone_norm
WHERE telefone_norm IS NOT NULL AND telefone_norm != '';

ALTER TABLE public.clientes DROP COLUMN IF EXISTS telefone_norm;

-- Constraint única: um cliente por (empresa, telefone)
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_company_telefone_unique;
ALTER TABLE public.clientes
  ADD CONSTRAINT clientes_company_telefone_unique UNIQUE (company_id, telefone);

-- Normalizar telefone em conversas (contato individual) para consistência
UPDATE public.conversas conv
SET telefone = (
  CASE
    WHEN conv.telefone LIKE '%@g.us' THEN conv.telefone
    WHEN trim(regexp_replace(conv.telefone, '\D', '', 'g')) = '' THEN conv.telefone
    WHEN length(regexp_replace(conv.telefone, '\D', '', 'g')) IN (10, 11)
      THEN '55' || regexp_replace(conv.telefone, '\D', '', 'g')
    WHEN regexp_replace(conv.telefone, '\D', '', 'g') ~ '^55'
      THEN left(regexp_replace(conv.telefone, '\D', '', 'g'), 13)
    ELSE left(regexp_replace(conv.telefone, '\D', '', 'g'), 13)
  END
)
WHERE conv.telefone IS NOT NULL AND conv.telefone != '' AND conv.telefone NOT LIKE '%@g.us';

-- Uma única conversa aberta/em atendimento por (empresa, telefone) para contato individual
-- (Se deu erro 23505 clientes_telefone_unique acima, execute FIX_CLIENTES_DUPLICATA.sql e depois este script todo de novo desde a linha 1.)
DROP INDEX IF EXISTS idx_conversas_company_telefone_open_unique;
CREATE UNIQUE INDEX idx_conversas_company_telefone_open_unique
  ON public.conversas (company_id, telefone)
  WHERE (tipo IS NULL OR tipo = 'cliente') AND status_atendimento IN ('aberta', 'em_atendimento');

-- Confirme no Supabase que não há erros. Depois reinicie o backend se estiver rodando.
