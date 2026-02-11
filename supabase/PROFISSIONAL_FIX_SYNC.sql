-- ============================================================
-- PROFISSIONAL_FIX_SYNC.sql
-- Objetivo:
-- 1) Eliminar duplicatas (12/13 dígitos com/sem 9 após DDD) em clientes e conversas
-- 2) Corrigir constraint antiga (clientes_telefone_unique) e padronizar unicidade por (company_id, telefone)
-- 3) Aumentar tamanho de conversas.telefone (caso ainda seja varchar(20))
--
-- Execute no Supabase (SQL Editor).
-- Faça um backup antes se o ambiente for produção.
-- ============================================================

-- 0) Garantir colunas usadas existem
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS foto_perfil text,
  ADD COLUMN IF NOT EXISTS pushname text;

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'cliente',
  ADD COLUMN IF NOT EXISTS nome_grupo text,
  ADD COLUMN IF NOT EXISTS foto_grupo text,
  ADD COLUMN IF NOT EXISTS ultima_atividade timestamp with time zone DEFAULT now();

-- 1) Aumentar tamanho do telefone da conversa (para não estourar em grupos/IDs)
-- Se já for text, isto é no-op em muitos casos; se for varchar(20), converte para text.
ALTER TABLE public.conversas
  ALTER COLUMN telefone TYPE text;

-- 2) Remover constraint antiga que bloqueia multi-tenant e provoca 23505 em webhook
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_telefone_unique;

-- 3) Criar coluna temporária para chave de deduplicação (remove o "9" após DDD quando existir)
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS telefone_key text;
UPDATE public.clientes
SET telefone_key = (
  CASE
    WHEN telefone IS NULL THEN NULL
    WHEN trim(regexp_replace(telefone, '\D', '', 'g')) = '' THEN NULL
    ELSE
      -- digits
      CASE
        WHEN left(regexp_replace(telefone, '\D', '', 'g'), 2) = '55'
          AND length(regexp_replace(telefone, '\D', '', 'g')) = 13
          AND substr(regexp_replace(telefone, '\D', '', 'g'), 5, 1) = '9'
          THEN left(regexp_replace(telefone, '\D', '', 'g'), 4) || substr(regexp_replace(telefone, '\D', '', 'g'), 6)
        WHEN left(regexp_replace(telefone, '\D', '', 'g'), 2) = '55'
          THEN left(regexp_replace(telefone, '\D', '', 'g'), 13)
        WHEN length(regexp_replace(telefone, '\D', '', 'g')) IN (10, 11)
          THEN '55' || regexp_replace(telefone, '\D', '', 'g')
        ELSE left(regexp_replace(telefone, '\D', '', 'g'), 13)
      END
  END
)
WHERE telefone IS NOT NULL;

-- 4) Apontar conversas para o cliente canônico (menor id por company_id + telefone_key)
UPDATE public.conversas conv
SET cliente_id = (
  SELECT min(cl.id)
  FROM public.clientes cl
  WHERE cl.company_id = (SELECT company_id FROM public.clientes WHERE id = conv.cliente_id)
    AND cl.telefone_key = (SELECT telefone_key FROM public.clientes WHERE id = conv.cliente_id)
)
WHERE conv.cliente_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.clientes cl2
    WHERE cl2.id = conv.cliente_id AND cl2.telefone_key IS NOT NULL
  );

-- 5) Remover clientes duplicados mantendo o menor id
DELETE FROM public.clientes a
USING public.clientes b
WHERE a.company_id = b.company_id
  AND a.telefone_key = b.telefone_key
  AND a.id > b.id;

-- 6) Padronizar telefone do cliente para apenas dígitos (55 + ...)
UPDATE public.clientes
SET telefone = (
  CASE
    WHEN telefone_key IS NULL THEN telefone
    ELSE left(telefone_key, 13)
  END
)
WHERE telefone_key IS NOT NULL;

-- 7) Limpar coluna temporária
ALTER TABLE public.clientes DROP COLUMN IF EXISTS telefone_key;

-- 8) Unicidade correta por empresa + telefone
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_company_telefone_unique;
ALTER TABLE public.clientes
  ADD CONSTRAINT clientes_company_telefone_unique UNIQUE (company_id, telefone);

-- 9) (Opcional) criar índice único para uma conversa aberta por (empresa, telefone) em contato individual
DROP INDEX IF EXISTS idx_conversas_company_telefone_open_unique;
CREATE UNIQUE INDEX idx_conversas_company_telefone_open_unique
  ON public.conversas (company_id, telefone)
  WHERE (tipo IS NULL OR tipo = 'cliente') AND status_atendimento IN ('aberta', 'em_atendimento');

