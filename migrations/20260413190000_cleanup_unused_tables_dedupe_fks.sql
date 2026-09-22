-- =====================================================
-- Limpeza de legado + deduplicação de FKs (sem mudar regras de negócio)
--
-- 1) public.grupos / public.comunidades — não são usadas pelo backend:
--    grupos/comunidades reais vivem em public.conversas (tipo + nome_grupo).
-- 2) Remove constraints FOREIGN KEY duplicadas no mesmo par (coluna → tabela),
--    reduzindo índices internos e custo em INSERT/UPDATE/DELETE.
-- 3) Índice em bot_logs para leituras frequentes por empresa + conversa.
--
-- Retenção de logs (webhook_logs, auditoria, bot_logs) não entra aqui:
--    isso apaga dados; faça política separada (cron/partição) se quiser aliviar disco.
-- =====================================================

-- ---------------------------------------------------------------------------
-- A) Tabelas legadas (sem referências no código Node deste repositório)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.grupos;
DROP TABLE IF EXISTS public.comunidades;

-- ---------------------------------------------------------------------------
-- B) conversas — remove FK duplicada quando o par existir (mantém a outra)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'conversas' AND c.conname = 'fk_conversa_cliente'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'conversas' AND c.conname = 'conversas_cliente_fk'
  ) THEN
    ALTER TABLE public.conversas DROP CONSTRAINT conversas_cliente_fk;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'conversas' AND c.conname = 'fk_usuario'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'conversas' AND c.conname = 'conversas_usuario_fk'
  ) THEN
    ALTER TABLE public.conversas DROP CONSTRAINT conversas_usuario_fk;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'conversas' AND c.conname = 'conversas_atendente_id_fkey'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'conversas' AND c.conname = 'conversas_atendente_fk'
  ) THEN
    ALTER TABLE public.conversas DROP CONSTRAINT conversas_atendente_fk;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- C) ia_config, bot_logs, regras_automaticas — company_id referenciado 2x
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname = 'public' AND t.relname = 'ia_config' AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) LIKE '%REFERENCES%empresas%';

  IF n >= 2 THEN
    ALTER TABLE public.ia_config DROP CONSTRAINT IF EXISTS ia_config_company_fk;
  END IF;
END $$;

DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname = 'public' AND t.relname = 'bot_logs' AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) LIKE '%REFERENCES%empresas%';

  IF n >= 2 THEN
    ALTER TABLE public.bot_logs DROP CONSTRAINT IF EXISTS bot_logs_company_fk;
  END IF;
END $$;

DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname = 'public' AND t.relname = 'regras_automaticas' AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) LIKE '%REFERENCES%empresas%';

  IF n >= 2 THEN
    ALTER TABLE public.regras_automaticas DROP CONSTRAINT IF EXISTS regras_company_fk;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D) respostas_salvas — company_id e departamento_id (quando duplicados)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname = 'public' AND t.relname = 'respostas_salvas' AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) LIKE '%REFERENCES%empresas%';

  IF n >= 2 THEN
    ALTER TABLE public.respostas_salvas DROP CONSTRAINT IF EXISTS respostas_salvas_company_fk;
  END IF;
END $$;

DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname = 'public' AND t.relname = 'respostas_salvas' AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) LIKE '%REFERENCES%departamentos%';

  IF n >= 2 THEN
    ALTER TABLE public.respostas_salvas DROP CONSTRAINT IF EXISTS respostas_salvas_departamento_fk;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- E) Índice para consultas do chatbot / diagnóstico por conversa (somente leitura mais rápida)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bot_logs_company_conversa_criado
  ON public.bot_logs (company_id, conversa_id, criado_em DESC);

COMMENT ON INDEX public.idx_bot_logs_company_conversa_criado IS
  'Suporta filtros por empresa + conversa ordenados por data (ex.: bot_logs no chatbot).';
