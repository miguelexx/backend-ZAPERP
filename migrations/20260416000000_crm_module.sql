-- ============================================================
-- Módulo CRM (ZapERP) — tabelas novas, multi-tenant por company_id
-- Compatível com empresas, usuarios, clientes, conversas, tags
-- ============================================================

-- ---------- Pipelines ----------
CREATE TABLE IF NOT EXISTS public.crm_pipelines (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nome varchar(255) NOT NULL,
  descricao text,
  cor varchar(32),
  ativo boolean NOT NULL DEFAULT true,
  ordem integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_pipelines_company_ordem ON public.crm_pipelines(company_id, ordem);
CREATE INDEX IF NOT EXISTS idx_crm_pipelines_company_ativo ON public.crm_pipelines(company_id, ativo);

COMMENT ON TABLE public.crm_pipelines IS 'Pipelines de vendas CRM por empresa';

-- ---------- Stages ----------
CREATE TABLE IF NOT EXISTS public.crm_stages (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  pipeline_id integer NOT NULL REFERENCES public.crm_pipelines(id) ON DELETE CASCADE,
  nome varchar(255) NOT NULL,
  descricao text,
  cor varchar(32),
  ordem integer NOT NULL DEFAULT 0,
  tipo_fechamento varchar(20),
  exige_motivo_perda boolean NOT NULL DEFAULT false,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_stages_tipo_fechamento_chk CHECK (
    tipo_fechamento IS NULL OR tipo_fechamento IN ('ganho', 'perdido')
  )
);
CREATE INDEX IF NOT EXISTS idx_crm_stages_company_pipeline ON public.crm_stages(company_id, pipeline_id, ordem);
CREATE INDEX IF NOT EXISTS idx_crm_stages_pipeline ON public.crm_stages(pipeline_id);

COMMENT ON COLUMN public.crm_stages.tipo_fechamento IS 'NULL=aberto; ganho/perdido=estágio terminal';

-- ---------- Origens ----------
CREATE TABLE IF NOT EXISTS public.crm_origens (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nome varchar(255) NOT NULL,
  descricao text,
  cor varchar(32),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_origens_company ON public.crm_origens(company_id, nome);

-- ---------- Leads ----------
CREATE TABLE IF NOT EXISTS public.crm_leads (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id integer REFERENCES public.clientes(id) ON DELETE SET NULL,
  conversa_id integer REFERENCES public.conversas(id) ON DELETE SET NULL,
  pipeline_id integer NOT NULL REFERENCES public.crm_pipelines(id) ON DELETE RESTRICT,
  stage_id integer NOT NULL REFERENCES public.crm_stages(id) ON DELETE RESTRICT,
  responsavel_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  origem_id integer REFERENCES public.crm_origens(id) ON DELETE SET NULL,
  nome varchar(500) NOT NULL,
  empresa varchar(500),
  telefone varchar(50),
  email varchar(320),
  valor_estimado numeric(14, 2),
  probabilidade integer,
  prioridade varchar(20) NOT NULL DEFAULT 'normal',
  status varchar(20) NOT NULL DEFAULT 'ativo',
  data_proximo_contato timestamptz,
  ultima_interacao_em timestamptz,
  perdido_motivo text,
  ganho_em timestamptz,
  perdido_em timestamptz,
  observacoes text,
  ordem integer NOT NULL DEFAULT 0,
  criado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_leads_prioridade_chk CHECK (prioridade IN ('baixa', 'normal', 'alta', 'urgente')),
  CONSTRAINT crm_leads_status_chk CHECK (status IN ('ativo', 'ganho', 'perdido', 'arquivado')),
  CONSTRAINT crm_leads_probabilidade_chk CHECK (probabilidade IS NULL OR (probabilidade >= 0 AND probabilidade <= 100))
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_pipeline ON public.crm_leads(company_id, pipeline_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_stage_ordem ON public.crm_leads(company_id, stage_id, ordem);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_responsavel ON public.crm_leads(company_id, responsavel_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_status ON public.crm_leads(company_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_origem ON public.crm_leads(company_id, origem_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_proximo ON public.crm_leads(company_id, data_proximo_contato);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_ultima ON public.crm_leads(company_id, ultima_interacao_em DESC);
CREATE INDEX IF NOT EXISTS idx_crm_leads_cliente ON public.crm_leads(company_id, cliente_id) WHERE cliente_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_leads_conversa ON public.crm_leads(company_id, conversa_id) WHERE conversa_id IS NOT NULL;

COMMENT ON COLUMN public.crm_leads.ordem IS 'Ordem do card dentro do estágio (kanban)';

-- ---------- Tags do lead (reutiliza public.tags) ----------
CREATE TABLE IF NOT EXISTS public.crm_lead_tags (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  lead_id integer NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_lead_tags_unique UNIQUE (lead_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_tags_company_lead ON public.crm_lead_tags(company_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_lead_tags_tag ON public.crm_lead_tags(company_id, tag_id);

-- ---------- Atividades ----------
CREATE TABLE IF NOT EXISTS public.crm_atividades (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  lead_id integer NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  tipo varchar(30) NOT NULL,
  titulo varchar(500) NOT NULL,
  descricao text,
  status varchar(20) NOT NULL DEFAULT 'pendente',
  data_agendada timestamptz,
  data_conclusao timestamptz,
  google_event_id varchar(255),
  criado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  responsavel_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_atividades_tipo_chk CHECK (
    tipo IN (
      'ligacao', 'reuniao', 'whatsapp', 'email', 'tarefa', 'nota',
      'visita', 'proposta', 'demo', 'outro'
    )
  ),
  CONSTRAINT crm_atividades_status_chk CHECK (status IN ('pendente', 'concluida', 'cancelada'))
);
CREATE INDEX IF NOT EXISTS idx_crm_atividades_company_lead ON public.crm_atividades(company_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_atividades_agenda ON public.crm_atividades(company_id, data_agendada);
CREATE INDEX IF NOT EXISTS idx_crm_atividades_google ON public.crm_atividades(company_id, google_event_id)
  WHERE google_event_id IS NOT NULL;

-- ---------- Notas internas ----------
CREATE TABLE IF NOT EXISTS public.crm_notas (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  lead_id integer NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  texto text NOT NULL,
  criado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_notas_company_lead ON public.crm_notas(company_id, lead_id, criado_em DESC);

-- ---------- Histórico de movimentações ----------
CREATE TABLE IF NOT EXISTS public.crm_stage_movements (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  lead_id integer NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  de_stage_id integer REFERENCES public.crm_stages(id) ON DELETE SET NULL,
  para_stage_id integer NOT NULL REFERENCES public.crm_stages(id) ON DELETE SET NULL,
  de_pipeline_id integer REFERENCES public.crm_pipelines(id) ON DELETE SET NULL,
  para_pipeline_id integer NOT NULL REFERENCES public.crm_pipelines(id) ON DELETE SET NULL,
  movido_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  motivo text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_stage_mov_company_lead ON public.crm_stage_movements(company_id, lead_id, criado_em DESC);

-- ---------- Tokens Google Calendar (OAuth por usuário/empresa) ----------
CREATE TABLE IF NOT EXISTS public.crm_google_tokens (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer REFERENCES public.usuarios(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  refresh_token text,
  scope text,
  token_type varchar(50),
  expiry_date bigint,
  email_google varchar(320),
  calendar_id varchar(255),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_google_tokens_company_user_unique UNIQUE (company_id, usuario_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_google_tokens_company ON public.crm_google_tokens(company_id, ativo);

COMMENT ON TABLE public.crm_google_tokens IS 'OAuth Google Calendar — tokens por (empresa, usuário)';

-- ---------- Log de erros / webhooks Google (sincronização) ----------
CREATE TABLE IF NOT EXISTS public.crm_webhook_logs_google (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  lead_id integer REFERENCES public.crm_leads(id) ON DELETE SET NULL,
  atividade_id integer REFERENCES public.crm_atividades(id) ON DELETE SET NULL,
  tipo varchar(50) NOT NULL DEFAULT 'sync',
  mensagem text,
  detalhes_json jsonb DEFAULT '{}',
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_google_logs_company ON public.crm_webhook_logs_google(company_id, criado_em DESC);

-- ---------- Motivos de perda reutilizáveis (opcional; lead ainda tem perdido_motivo texto) ----------
CREATE TABLE IF NOT EXISTS public.crm_lost_reasons (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nome varchar(255) NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  ordem integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_lost_reasons_company ON public.crm_lost_reasons(company_id, ordem);

-- ---------- Config CRM leve (feature flags / padrões por empresa) ----------
CREATE TABLE IF NOT EXISTS public.crm_config (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  chave varchar(100) NOT NULL,
  valor jsonb NOT NULL DEFAULT '{}',
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_config_company_chave_unique UNIQUE (company_id, chave)
);

-- ---------- Consistência lead / pipeline / stage / FKs multi-tenant ----------
CREATE OR REPLACE FUNCTION public.crm_enforce_lead_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id IS NULL OR NEW.company_id <= 0 THEN
    RAISE EXCEPTION 'crm_leads.company_id inválido';
  END IF;

  IF NEW.cliente_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clientes c
      WHERE c.id = NEW.cliente_id AND c.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'cliente_id não pertence à empresa';
    END IF;
  END IF;

  IF NEW.conversa_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.conversas cv
      WHERE cv.id = NEW.conversa_id AND cv.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'conversa_id não pertence à empresa';
    END IF;
  END IF;

  IF NEW.origem_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.crm_origens o
      WHERE o.id = NEW.origem_id AND o.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'origem_id não pertence à empresa';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.crm_stages s
    INNER JOIN public.crm_pipelines p ON p.id = s.pipeline_id
    WHERE s.id = NEW.stage_id
      AND p.id = NEW.pipeline_id
      AND s.company_id = NEW.company_id
      AND p.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'pipeline_id e stage_id inconsistentes ou fora da empresa';
  END IF;

  IF NEW.responsavel_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.usuarios u
      WHERE u.id = NEW.responsavel_id AND u.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'responsavel_id não pertence à empresa';
    END IF;
  END IF;

  IF NEW.criado_por IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.usuarios u
      WHERE u.id = NEW.criado_por AND u.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'criado_por não pertence à empresa';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_consistency ON public.crm_leads;
CREATE TRIGGER trg_crm_leads_consistency
  BEFORE INSERT OR UPDATE OF company_id, cliente_id, conversa_id, origem_id, pipeline_id, stage_id, responsavel_id, criado_por
  ON public.crm_leads
  FOR EACH ROW
  EXECUTE PROCEDURE public.crm_enforce_lead_consistency();

CREATE OR REPLACE FUNCTION public.crm_enforce_lead_tag_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.crm_leads l
    WHERE l.id = NEW.lead_id AND l.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'lead_id não pertence à empresa';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tags t
    WHERE t.id = NEW.tag_id AND t.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'tag_id não pertence à empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_tags_consistency ON public.crm_lead_tags;
CREATE TRIGGER trg_crm_lead_tags_consistency
  BEFORE INSERT OR UPDATE OF company_id, lead_id, tag_id
  ON public.crm_lead_tags
  FOR EACH ROW
  EXECUTE PROCEDURE public.crm_enforce_lead_tag_consistency();

CREATE OR REPLACE FUNCTION public.crm_enforce_atividade_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.crm_leads l
    WHERE l.id = NEW.lead_id AND l.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'atividade: lead_id não pertence à empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_atividades_consistency ON public.crm_atividades;
CREATE TRIGGER trg_crm_atividades_consistency
  BEFORE INSERT OR UPDATE OF company_id, lead_id
  ON public.crm_atividades
  FOR EACH ROW
  EXECUTE PROCEDURE public.crm_enforce_atividade_consistency();

CREATE OR REPLACE FUNCTION public.crm_enforce_nota_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.crm_leads l
    WHERE l.id = NEW.lead_id AND l.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'nota: lead_id não pertence à empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_notas_consistency ON public.crm_notas;
CREATE TRIGGER trg_crm_notas_consistency
  BEFORE INSERT OR UPDATE OF company_id, lead_id
  ON public.crm_notas
  FOR EACH ROW
  EXECUTE PROCEDURE public.crm_enforce_nota_consistency();

-- ---------- Seed: pipeline e estágios padrão por empresa (somente se ainda não houver pipeline) ----------
DO $$
DECLARE
  r RECORD;
  v_pipeline_id integer;
BEGIN
  FOR r IN SELECT id AS empresa_id FROM public.empresas LOOP
    IF EXISTS (SELECT 1 FROM public.crm_pipelines p WHERE p.company_id = r.empresa_id) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.crm_pipelines (company_id, nome, descricao, cor, ativo, ordem)
    VALUES (r.empresa_id, 'Vendas', 'Pipeline padrão do CRM', '#6366f1', true, 0)
    RETURNING id INTO v_pipeline_id;

    INSERT INTO public.crm_stages (company_id, pipeline_id, nome, descricao, cor, ordem, tipo_fechamento, exige_motivo_perda, ativo)
    VALUES
      (r.empresa_id, v_pipeline_id, 'Novo', 'Novos leads', '#94a3b8', 10, NULL, false, true),
      (r.empresa_id, v_pipeline_id, 'Qualificação', 'Qualificação', '#3b82f6', 20, NULL, false, true),
      (r.empresa_id, v_pipeline_id, 'Proposta', 'Proposta enviada', '#f59e0b', 30, NULL, false, true),
      (r.empresa_id, v_pipeline_id, 'Negociação', 'Negociação', '#a855f7', 40, NULL, false, true),
      (r.empresa_id, v_pipeline_id, 'Ganho', 'Negócio ganho', '#22c55e', 50, 'ganho', false, true),
      (r.empresa_id, v_pipeline_id, 'Perdido', 'Negócio perdido', '#ef4444', 60, 'perdido', true, true);
  END LOOP;
END $$;
