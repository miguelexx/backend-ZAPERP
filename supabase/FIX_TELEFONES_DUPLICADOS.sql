-- ============================================================
-- FIX: Telefones duplicados e inválidos na tabela clientes
-- Execute no Supabase: SQL Editor → New query → Run
-- ============================================================

-- ── 1) Remover clientes criados com chave LID (número inválido) ──────────────
-- Chaves "lid:XXXX" são identificadores internos do WhatsApp, nunca números reais.
-- Antes de remover, desvincula conversas ligadas a esses clientes.

UPDATE public.conversas
SET cliente_id = NULL
WHERE cliente_id IN (
  SELECT id FROM public.clientes
  WHERE telefone LIKE 'lid:%'
);

DELETE FROM public.clientes
WHERE telefone LIKE 'lid:%';

-- ── 2) Normalizar telefones legados (sem DDI 55) ──────────────────────────────
-- Ex.: "34999999999" (11 dígitos) → "5534999999999" (13 dígitos)

UPDATE public.clientes
SET telefone = '55' || telefone
WHERE
  telefone NOT LIKE '55%'
  AND telefone NOT LIKE '%@g.us'
  AND telefone NOT LIKE 'lid:%'
  AND length(regexp_replace(telefone, '\D', '', 'g')) IN (10, 11);

-- ── 3) Identificar e consolidar clientes duplicados ───────────────────────────
-- Para cada par de clientes com mesmo (company_id + últimos 10 dígitos do telefone),
-- mantém o mais antigo (menor id) e transfere as dependências para ele.

-- 3a) Transferir conversas
UPDATE public.conversas conv
SET cliente_id = canonical.id
FROM (
  SELECT
    company_id,
    MIN(id) AS id,
    right(regexp_replace(telefone, '\D', '', 'g'), 10) AS tel10
  FROM public.clientes
  WHERE
    telefone IS NOT NULL
    AND telefone <> ''
    AND telefone NOT LIKE '%@g.us'
    AND length(regexp_replace(telefone, '\D', '', 'g')) >= 10
  GROUP BY company_id, right(regexp_replace(telefone, '\D', '', 'g'), 10)
  HAVING COUNT(*) > 1
) canonical
JOIN public.clientes dup
  ON dup.company_id = canonical.company_id
  AND right(regexp_replace(dup.telefone, '\D', '', 'g'), 10) = canonical.tel10
  AND dup.id <> canonical.id
WHERE conv.cliente_id = dup.id
  AND conv.company_id = canonical.company_id;

-- 3b) Remover os duplicados (mantém o canonical com menor id)
DELETE FROM public.clientes
WHERE id IN (
  SELECT dup.id
  FROM (
    SELECT
      company_id,
      MIN(id) AS id_canonical,
      right(regexp_replace(telefone, '\D', '', 'g'), 10) AS tel10
    FROM public.clientes
    WHERE
      telefone IS NOT NULL
      AND telefone <> ''
      AND telefone NOT LIKE '%@g.us'
      AND length(regexp_replace(telefone, '\D', '', 'g')) >= 10
    GROUP BY company_id, right(regexp_replace(telefone, '\D', '', 'g'), 10)
    HAVING COUNT(*) > 1
  ) canonical
  JOIN public.clientes dup
    ON dup.company_id = canonical.company_id
    AND right(regexp_replace(dup.telefone, '\D', '', 'g'), 10) = canonical.tel10
    AND dup.id <> canonical.id
);

-- ── 4) Criar constraint UNIQUE (company_id, telefone) em clientes ─────────────
-- Garante que o banco nunca aceite dois clientes com o mesmo número na mesma empresa.

ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_company_telefone_unique;

ALTER TABLE public.clientes
  ADD CONSTRAINT clientes_company_telefone_unique
  UNIQUE (company_id, telefone);

-- ── 5) Garantir UNIQUE em conversas abertas por (company_id, telefone) ────────
-- Já existia como índice; certificar que está criado.
DROP INDEX IF EXISTS idx_conversas_company_telefone_open_unique;
CREATE UNIQUE INDEX idx_conversas_company_telefone_open_unique
  ON public.conversas (company_id, telefone)
  WHERE (tipo IS NULL OR tipo = 'cliente') AND status_atendimento IN ('aberta', 'em_atendimento');

-- ── 6) Verificar resultado ────────────────────────────────────────────────────
SELECT 'clientes_lid_restantes' AS check, COUNT(*) FROM public.clientes WHERE telefone LIKE 'lid:%'
UNION ALL
SELECT 'clientes_sem_ddi' AS check, COUNT(*) FROM public.clientes
  WHERE telefone NOT LIKE '55%' AND telefone NOT LIKE '%@g.us' AND telefone NOT LIKE 'lid:%'
    AND length(regexp_replace(telefone, '\D', '', 'g')) IN (10, 11)
UNION ALL
SELECT 'clientes_total' AS check, COUNT(*) FROM public.clientes;
