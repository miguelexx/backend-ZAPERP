-- ============================================================
-- IA do Dashboard ZapERP — Tabelas de suporte
-- Execute este script no Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) ai_logs — auditoria completa de todas as perguntas
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_logs (
  id          bigserial   PRIMARY KEY,
  company_id  int         NOT NULL,
  usuario_id  int         NULL,
  question    text        NOT NULL,
  intent      varchar(100) NULL,
  response    text        NULL,
  tokens_used int         NULL,
  success     boolean     NOT NULL DEFAULT false,
  ip          varchar(50) NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.ai_logs IS 'Log de auditoria de todas as chamadas ao Assistente IA do Dashboard.';
COMMENT ON COLUMN public.ai_logs.success IS 'true = resposta ok entregue ao usuário; false = erro ou UNKNOWN.';
COMMENT ON COLUMN public.ai_logs.tokens_used IS 'Total de tokens OpenAI consumidos (preenchido futuramente).';

-- Índice principal: consultas de limite mensal e relatório por empresa
CREATE INDEX IF NOT EXISTS idx_ai_logs_company_created
  ON public.ai_logs (company_id, created_at DESC);

-- Índice secundário: filtrar por sucesso no mês (verificação de cota)
CREATE INDEX IF NOT EXISTS idx_ai_logs_company_success_created
  ON public.ai_logs (company_id, success, created_at DESC);

-- RLS — empresa só acessa seus próprios logs
ALTER TABLE public.ai_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ai_logs' AND policyname = 'ai_logs_company_isolation'
  ) THEN
    CREATE POLICY ai_logs_company_isolation ON public.ai_logs
      USING (company_id = (current_setting('app.company_id', true)::int));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 2) ai_cache — cache de respostas (TTL 24h)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_cache (
  id            bigserial    PRIMARY KEY,
  company_id    int          NOT NULL,
  question_hash char(64)     NOT NULL,
  question      text         NOT NULL,
  response      jsonb        NOT NULL,
  intent        varchar(100) NULL,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  expires_at    timestamptz  NOT NULL,

  CONSTRAINT ai_cache_company_hash_uq UNIQUE (company_id, question_hash)
);

COMMENT ON TABLE  public.ai_cache IS 'Cache de respostas do Assistente IA (chave = SHA-256 da pergunta normalizada + company_id).';
COMMENT ON COLUMN public.ai_cache.question_hash IS 'SHA-256(company_id:question_normalizada:period_days).';
COMMENT ON COLUMN public.ai_cache.response IS 'Objeto JSON completo { ok, intent, answer, data } retornado ao cliente.';
COMMENT ON COLUMN public.ai_cache.expires_at IS 'Cache inválido após esta data (TTL padrão: 24h).';

-- Índice de lookup: busca por hash + validade
CREATE INDEX IF NOT EXISTS idx_ai_cache_lookup
  ON public.ai_cache (company_id, question_hash, expires_at DESC);

-- Índice de limpeza de entradas expiradas
CREATE INDEX IF NOT EXISTS idx_ai_cache_expires
  ON public.ai_cache (expires_at);

-- RLS
ALTER TABLE public.ai_cache ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ai_cache' AND policyname = 'ai_cache_company_isolation'
  ) THEN
    CREATE POLICY ai_cache_company_isolation ON public.ai_cache
      USING (company_id = (current_setting('app.company_id', true)::int));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 3) empresas.ai_limit_per_month — cota mensal por empresa
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS ai_limit_per_month int NULL;

COMMENT ON COLUMN public.empresas.ai_limit_per_month
  IS 'Limite de perguntas de IA por mês por empresa. NULL = usa padrão do sistema (1000). 0 = bloqueado.';

-- ────────────────────────────────────────────────────────────
-- 4) Função de limpeza automática do cache expirado
--    (opcional: criar via pg_cron ou chamar manualmente)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_cache_cleanup()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM public.ai_cache WHERE expires_at < now();
$$;

COMMENT ON FUNCTION public.ai_cache_cleanup()
  IS 'Remove entradas expiradas do ai_cache. Chamar periodicamente via cron.';
