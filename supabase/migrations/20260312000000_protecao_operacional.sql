-- =====================================================
-- Proteção Operacional ZapERP
-- Tabelas: configuracoes_operacionais, jobs, auditoria_eventos, checkpoints_sync, sync_locks
-- =====================================================

-- 1) configuracoes_operacionais — configurações por empresa
CREATE TABLE IF NOT EXISTS public.configuracoes_operacionais (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  sync_auto boolean DEFAULT false,
  lote_max integer DEFAULT 50,
  intervalo_lotes_seg integer DEFAULT 5,
  pausa_blocos_seg integer DEFAULT 30,
  concorrencia_max integer DEFAULT 2,
  retry_max integer DEFAULT 3,
  cooldown_erro_seg integer DEFAULT 60,
  modo_seguro boolean DEFAULT true,
  somente_atendimento_humano boolean DEFAULT false,
  processamento_pausado boolean DEFAULT false,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now(),
  UNIQUE(company_id)
);
CREATE INDEX IF NOT EXISTS idx_config_operacionais_company ON public.configuracoes_operacionais(company_id);
COMMENT ON TABLE public.configuracoes_operacionais IS 'Configurações operacionais: lotes, intervalos, modo seguro, pausa';

-- 2) jobs — fila de tarefas assíncronas
CREATE TABLE IF NOT EXISTS public.jobs (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  tipo varchar(50) NOT NULL,
  payload jsonb DEFAULT '{}',
  status varchar(30) NOT NULL DEFAULT 'pending',
  tentativas integer DEFAULT 0,
  max_tentativas integer DEFAULT 3,
  next_run_at timestamptz,
  resultado_json jsonb,
  erro text,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_company_status ON public.jobs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_status_next ON public.jobs(status, next_run_at) WHERE status = 'pending';
COMMENT ON TABLE public.jobs IS 'Fila de jobs: sync_contatos, sync_fotos, sync_conversas';

-- 3) auditoria_eventos — eventos operacionais (sync, conexão, pausas)
CREATE TABLE IF NOT EXISTS public.auditoria_eventos (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  tipo varchar(50) NOT NULL,
  evento varchar(100) NOT NULL,
  detalhes_json jsonb DEFAULT '{}',
  criado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_company_criado ON public.auditoria_eventos(company_id, criado_em DESC);
COMMENT ON TABLE public.auditoria_eventos IS 'Eventos operacionais: conexao, sync_inicio, sync_fim, sync_lote, falha, pausa, config_alterada';

-- 4) checkpoints_sync — progresso retomável de sincronizações
CREATE TABLE IF NOT EXISTS public.checkpoints_sync (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  tipo varchar(50) NOT NULL,
  ultimo_offset integer DEFAULT 0,
  ultimo_id bigint,
  detalhes_json jsonb DEFAULT '{}',
  atualizado_em timestamptz DEFAULT now(),
  UNIQUE(company_id, tipo)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_company_tipo ON public.checkpoints_sync(company_id, tipo);
COMMENT ON TABLE public.checkpoints_sync IS 'Checkpoint para retomada de sync progressiva';

-- 5) sync_locks — trava para evitar sync simultânea
CREATE TABLE IF NOT EXISTS public.sync_locks (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  tipo varchar(50) NOT NULL,
  locked_at timestamptz DEFAULT now(),
  locked_by varchar(100),
  UNIQUE(company_id, tipo)
);
CREATE INDEX IF NOT EXISTS idx_sync_locks_company_tipo ON public.sync_locks(company_id, tipo);
COMMENT ON TABLE public.sync_locks IS 'Lock para impedir duas sincronizações simultâneas do mesmo tipo';

-- 6) zapi_auto_sync_contatos: default false para novas empresas
-- Garante coluna existe; altera apenas DEFAULT para inserts futuros (não altera dados existentes)
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS zapi_auto_sync_contatos boolean;
ALTER TABLE public.empresas ALTER COLUMN zapi_auto_sync_contatos SET DEFAULT false;
