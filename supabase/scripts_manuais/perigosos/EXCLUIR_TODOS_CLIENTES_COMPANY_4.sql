-- =========================================================
-- Empresa company_id = 4
--
-- FASE 1 — public.clientes: remove todos os clientes da empresa.
-- FASE 2 — public.conversas: remove todos os CHATS da empresa (é isto que a lista
--          do painel mostra: conversas finalizadas, nome_contato_cache, etc.).
--          Só apagar clientes deixa as conversas e os contactos continuam visíveis.
--
-- Ordem e limpezas extra evitam falhas de FK (ex.: contato_opt_out).
-- Execute no SQL Editor como role com bypass de RLS (ex.: postgres / service_role).
-- =========================================================

BEGIN;

-- Sintaxe PG: ON COMMIT DROP vem antes de AS (não misturar com lista de colunas + AS)
CREATE TEMP TABLE tmp_clientes_c4 ON COMMIT DROP AS
SELECT c.id FROM public.clientes c WHERE c.company_id = 4;

ALTER TABLE tmp_clientes_c4 ADD PRIMARY KEY (id);

-- Diagnóstico (opcional): quantos serão removidos
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM tmp_clientes_c4;
  RAISE NOTICE 'Clientes company_id=4 a remover: %', n;
END $$;

-- 1) Avaliações ligadas a esses clientes
DELETE FROM public.avaliacoes_atendimento a
WHERE a.cliente_id IN (SELECT t.id FROM tmp_clientes_c4 t);

-- 2) Opt-out: NÃO confiar só em ON DELETE SET NULL — pode violar CHECK
--    (cliente_id IS NOT NULL OR telefone IS NOT NULL) se telefone for NULL.
DELETE FROM public.contato_opt_out o
WHERE o.cliente_id IN (SELECT t.id FROM tmp_clientes_c4 t);

-- 3) Opt-in e campanhas (redundante se já houver CASCADE, mas garante ordem)
DELETE FROM public.contato_opt_in i
WHERE i.cliente_id IN (SELECT t.id FROM tmp_clientes_c4 t);

DELETE FROM public.campanha_envios e
WHERE e.cliente_id IN (SELECT t.id FROM tmp_clientes_c4 t);

DELETE FROM public.cliente_tags ct
WHERE ct.cliente_id IN (SELECT t.id FROM tmp_clientes_c4 t);

-- 4) Qualquer conversa (de qualquer empresa) que aponte para estes clientes
UPDATE public.conversas c
SET cliente_id = NULL
WHERE c.cliente_id IN (SELECT t.id FROM tmp_clientes_c4 t);

-- 5) Apagar exatamente os clientes capturados (empresa 4 no momento do snapshot)
DELETE FROM public.clientes cl
WHERE cl.id IN (SELECT t.id FROM tmp_clientes_c4 t);

-- ========== FASE 2 — Lista do painel (conversas + filhas) ==========

CREATE TEMP TABLE tmp_conv_c4 ON COMMIT DROP AS
SELECT c.id FROM public.conversas c WHERE c.company_id = 4;

ALTER TABLE tmp_conv_c4 ADD PRIMARY KEY (id);

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM tmp_conv_c4;
  RAISE NOTICE 'Conversas company_id=4 a remover (lista do painel): %', n;
END $$;

DELETE FROM public.historico_atendimentos h
WHERE h.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t);

DELETE FROM public.avaliacoes_atendimento a
WHERE a.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t)
   OR a.atendimento_id IN (
        SELECT at.id FROM public.atendimentos at
        WHERE at.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t)
      );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mensagens_ocultas'
  ) THEN
    DELETE FROM public.mensagens_ocultas mo
    WHERE mo.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t);
  END IF;
END $$;

DELETE FROM public.conversa_unreads cu
WHERE cu.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t);

DELETE FROM public.atendimentos a
WHERE a.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t);

DELETE FROM public.conversa_tags ct
WHERE ct.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t);

DELETE FROM public.bot_logs bl
WHERE bl.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t);

DELETE FROM public.mensagens m
WHERE m.conversa_id IN (SELECT t.id FROM tmp_conv_c4 t);

UPDATE public.conversas c
SET cliente_id = NULL
WHERE c.id IN (SELECT t.id FROM tmp_conv_c4 t);

DELETE FROM public.conversas c
WHERE c.id IN (SELECT t.id FROM tmp_conv_c4 t);

DO $$
DECLARE
  n_cli int;
  n_conv int;
BEGIN
  SELECT COUNT(*)::int INTO n_cli FROM public.clientes WHERE company_id = 4;
  SELECT COUNT(*)::int INTO n_conv FROM public.conversas WHERE company_id = 4;
  IF n_cli > 0 THEN
    RAISE WARNING 'Ainda restam % clientes com company_id=4. Verifique FKs ou RLS.', n_cli;
  ELSE
    RAISE NOTICE 'OK: nenhum cliente restante com company_id=4.';
  END IF;
  IF n_conv > 0 THEN
    RAISE WARNING 'Ainda restam % conversas com company_id=4 (outra FK?).', n_conv;
  ELSE
    RAISE NOTICE 'OK: nenhuma conversa restante com company_id=4 (lista do painel limpa).';
  END IF;
END $$;

COMMIT;

-- Verificação manual:
-- SELECT COUNT(*) FROM public.clientes WHERE company_id = 4;
-- SELECT c.id, c.company_id, c.cliente_id FROM public.conversas c
--   WHERE c.cliente_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM public.clientes cl WHERE cl.id = c.cliente_id);
