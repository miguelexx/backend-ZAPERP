-- CRM profissional: campos completos, campanhas, timeline e hardening multi-tenant.
-- Idempotente para bases que ja possuem o modulo CRM parcial.

-- ---------- Leads: cadastro completo ----------
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS cpf_cnpj varchar(32),
  ADD COLUMN IF NOT EXISTS whatsapp varchar(50),
  ADD COLUMN IF NOT EXISTS cidade varchar(120),
  ADD COLUMN IF NOT EXISTS uf varchar(2),
  ADD COLUMN IF NOT EXISTS campanha_id integer,
  ADD COLUMN IF NOT EXISTS valor_ganho numeric(14, 2),
  ADD COLUMN IF NOT EXISTS data_prevista_fechamento timestamptz,
  ADD COLUMN IF NOT EXISTS temperatura varchar(20) NOT NULL DEFAULT 'morno',
  ADD COLUMN IF NOT EXISTS motivo_perda_id integer,
  ADD COLUMN IF NOT EXISTS motivo_perda_observacao text,
  ADD COLUMN IF NOT EXISTS produtos_interesse jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS data_primeiro_contato timestamptz,
  ADD COLUMN IF NOT EXISTS data_ultimo_contato timestamptz,
  ADD COLUMN IF NOT EXISTS data_proxima_acao timestamptz,
  ADD COLUMN IF NOT EXISTS data_entrada_stage timestamptz,
  ADD COLUMN IF NOT EXISTS atualizado_por integer;

DO $$
BEGIN
  ALTER TABLE public.crm_leads
    ADD CONSTRAINT crm_leads_temperatura_chk CHECK (temperatura IN ('frio', 'morno', 'quente'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_leads_company_campanha ON public.crm_leads(company_id, campanha_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_created ON public.crm_leads(company_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_updated ON public.crm_leads(company_id, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_prev_fechamento ON public.crm_leads(company_id, data_prevista_fechamento);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_ultima_interacao ON public.crm_leads(company_id, data_ultimo_contato DESC);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_proxima_acao ON public.crm_leads(company_id, data_proxima_acao);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_temperatura ON public.crm_leads(company_id, temperatura);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_cpf_cnpj ON public.crm_leads(company_id, cpf_cnpj) WHERE cpf_cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_whatsapp ON public.crm_leads(company_id, whatsapp) WHERE whatsapp IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_email ON public.crm_leads(company_id, lower(email)) WHERE email IS NOT NULL;

-- ---------- Pipelines e stages avancados ----------
ALTER TABLE public.crm_pipelines
  ADD COLUMN IF NOT EXISTS criado_por integer,
  ADD COLUMN IF NOT EXISTS atualizado_por integer;

ALTER TABLE public.crm_stages
  ADD COLUMN IF NOT EXISTS probabilidade_padrao integer,
  ADD COLUMN IF NOT EXISTS tempo_maximo_horas integer,
  ADD COLUMN IF NOT EXISTS criado_por integer,
  ADD COLUMN IF NOT EXISTS atualizado_por integer;

DO $$
BEGIN
  ALTER TABLE public.crm_stages
    ADD CONSTRAINT crm_stages_probabilidade_padrao_chk CHECK (
      probabilidade_padrao IS NULL OR (probabilidade_padrao >= 0 AND probabilidade_padrao <= 100)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_stages_company_ativo_ordem ON public.crm_stages(company_id, ativo, ordem);

-- ---------- Origens ----------
ALTER TABLE public.crm_origens
  ADD COLUMN IF NOT EXISTS criado_por integer,
  ADD COLUMN IF NOT EXISTS atualizado_por integer;

-- ---------- Campanhas ----------
CREATE TABLE IF NOT EXISTS public.crm_campaigns (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  origem_id integer REFERENCES public.crm_origens(id) ON DELETE SET NULL,
  nome varchar(255) NOT NULL,
  custo numeric(14, 2),
  data_inicio date,
  data_fim date,
  ativo boolean NOT NULL DEFAULT true,
  criado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  atualizado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_campaigns_company_nome_unique
  ON public.crm_campaigns(company_id, lower(nome));
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_company_origem ON public.crm_campaigns(company_id, origem_id);
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_company_ativo ON public.crm_campaigns(company_id, ativo);
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_company_periodo ON public.crm_campaigns(company_id, data_inicio, data_fim);

DO $$
BEGIN
  ALTER TABLE public.crm_leads
    ADD CONSTRAINT crm_leads_campanha_fk FOREIGN KEY (campanha_id)
    REFERENCES public.crm_campaigns(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- Motivos de perda ----------
ALTER TABLE public.crm_lost_reasons
  ADD COLUMN IF NOT EXISTS descricao text,
  ADD COLUMN IF NOT EXISTS criado_por integer,
  ADD COLUMN IF NOT EXISTS atualizado_por integer;

-- Tags continuam usando public.tags, compartilhada com conversas; adiciona status para uso CRM.
ALTER TABLE public.tags
  ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS atualizado_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_crm_lost_reasons_company_nome
  ON public.crm_lost_reasons(company_id, lower(nome));

DO $$
BEGIN
  ALTER TABLE public.crm_leads
    ADD CONSTRAINT crm_leads_motivo_perda_fk FOREIGN KEY (motivo_perda_id)
    REFERENCES public.crm_lost_reasons(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE VIEW public.crm_loss_reasons AS
SELECT id, company_id, nome, descricao, ativo, ordem, criado_por, atualizado_por, criado_em, atualizado_em
FROM public.crm_lost_reasons;

-- ---------- Atividades completas ----------
ALTER TABLE public.crm_atividades
  ADD COLUMN IF NOT EXISTS prioridade varchar(20) NOT NULL DEFAULT 'media',
  ADD COLUMN IF NOT EXISTS resultado text,
  ADD COLUMN IF NOT EXISTS proximo_passo text,
  ADD COLUMN IF NOT EXISTS cancelada_em timestamptz,
  ADD COLUMN IF NOT EXISTS atualizado_por integer;

DO $$
BEGIN
  ALTER TABLE public.crm_atividades
    ADD CONSTRAINT crm_atividades_prioridade_chk CHECK (prioridade IN ('baixa', 'media', 'alta'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.crm_atividades DROP CONSTRAINT IF EXISTS crm_atividades_tipo_chk;
ALTER TABLE public.crm_atividades
  ADD CONSTRAINT crm_atividades_tipo_chk CHECK (
    tipo IN (
      'ligacao', 'reuniao', 'whatsapp', 'email', 'tarefa', 'nota',
      'visita', 'proposta', 'demo', 'demonstracao', 'retorno', 'outro'
    )
  );

CREATE INDEX IF NOT EXISTS idx_crm_atividades_company_resp ON public.crm_atividades(company_id, responsavel_id);
CREATE INDEX IF NOT EXISTS idx_crm_atividades_company_tipo ON public.crm_atividades(company_id, tipo);
CREATE INDEX IF NOT EXISTS idx_crm_atividades_company_status_data ON public.crm_atividades(company_id, status, data_agendada);

-- ---------- Timeline ----------
CREATE TABLE IF NOT EXISTS public.crm_timeline (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  lead_id integer NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  usuario_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  tipo varchar(60) NOT NULL,
  titulo varchar(255) NOT NULL,
  descricao text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_timeline_company_lead_created
  ON public.crm_timeline(company_id, lead_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_crm_timeline_company_tipo
  ON public.crm_timeline(company_id, tipo, criado_em DESC);

CREATE OR REPLACE FUNCTION public.crm_enforce_timeline_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.crm_leads l
    WHERE l.id = NEW.lead_id AND l.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'timeline: lead_id nao pertence a empresa';
  END IF;
  IF NEW.usuario_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE u.id = NEW.usuario_id AND u.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'timeline: usuario_id nao pertence a empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_timeline_consistency ON public.crm_timeline;
CREATE TRIGGER trg_crm_timeline_consistency
  BEFORE INSERT OR UPDATE OF company_id, lead_id, usuario_id
  ON public.crm_timeline
  FOR EACH ROW
  EXECUTE PROCEDURE public.crm_enforce_timeline_consistency();

-- ---------- Consistencia extra em campanhas/motivos ----------
CREATE OR REPLACE FUNCTION public.crm_enforce_campaign_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.origem_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.crm_origens o
    WHERE o.id = NEW.origem_id AND o.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'campanha: origem_id nao pertence a empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_campaign_consistency ON public.crm_campaigns;
CREATE TRIGGER trg_crm_campaign_consistency
  BEFORE INSERT OR UPDATE OF company_id, origem_id
  ON public.crm_campaigns
  FOR EACH ROW
  EXECUTE PROCEDURE public.crm_enforce_campaign_consistency();

-- Reforca leads com novos vinculos multi-tenant.
CREATE OR REPLACE FUNCTION public.crm_enforce_lead_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id IS NULL OR NEW.company_id <= 0 THEN
    RAISE EXCEPTION 'crm_leads.company_id invalido';
  END IF;

  IF NEW.cliente_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clientes c
    WHERE c.id = NEW.cliente_id AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'cliente_id nao pertence a empresa';
  END IF;

  IF NEW.conversa_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversas cv
    WHERE cv.id = NEW.conversa_id AND cv.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'conversa_id nao pertence a empresa';
  END IF;

  IF NEW.origem_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.crm_origens o
    WHERE o.id = NEW.origem_id AND o.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'origem_id nao pertence a empresa';
  END IF;

  IF NEW.campanha_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.crm_campaigns c
    WHERE c.id = NEW.campanha_id AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'campanha_id nao pertence a empresa';
  END IF;

  IF NEW.motivo_perda_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.crm_lost_reasons r
    WHERE r.id = NEW.motivo_perda_id AND r.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'motivo_perda_id nao pertence a empresa';
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

  IF NEW.responsavel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE u.id = NEW.responsavel_id AND u.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'responsavel_id nao pertence a empresa';
  END IF;

  IF NEW.criado_por IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE u.id = NEW.criado_por AND u.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'criado_por nao pertence a empresa';
  END IF;

  IF NEW.atualizado_por IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE u.id = NEW.atualizado_por AND u.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'atualizado_por nao pertence a empresa';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_consistency ON public.crm_leads;
CREATE TRIGGER trg_crm_leads_consistency
  BEFORE INSERT OR UPDATE OF company_id, cliente_id, conversa_id, origem_id, campanha_id,
    motivo_perda_id, pipeline_id, stage_id, responsavel_id, criado_por, atualizado_por
  ON public.crm_leads
  FOR EACH ROW
  EXECUTE PROCEDURE public.crm_enforce_lead_consistency();

-- ---------- Seeds de motivos comuns ----------
INSERT INTO public.crm_lost_reasons (company_id, nome, descricao, ativo, ordem)
SELECT e.id, seed.nome, seed.descricao, true, seed.ordem
FROM public.empresas e
CROSS JOIN (VALUES
  ('Preco', 'Preco acima do esperado pelo lead', 10),
  ('Sem interesse', 'Lead informou que nao tem interesse no momento', 20),
  ('Comprou de concorrente', 'Lead fechou com outro fornecedor', 30),
  ('Sem resposta', 'Lead nao respondeu aos contatos', 40),
  ('Prazo incompativel', 'Prazo esperado nao atende a necessidade', 50),
  ('Produto nao atende', 'Oferta atual nao atende o caso do lead', 60),
  ('Lead invalido', 'Contato invalido ou fora do perfil', 70),
  ('Outro', 'Motivo nao classificado', 80)
) AS seed(nome, descricao, ordem)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.crm_lost_reasons r
  WHERE r.company_id = e.id AND lower(r.nome) = lower(seed.nome)
);
