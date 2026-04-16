-- CRM operacional: pipeline padrão, estágio inicial, atividades com fim/participantes/timezone, links Google

ALTER TABLE public.crm_pipelines
  ADD COLUMN IF NOT EXISTS padrao boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.crm_pipelines.padrao IS 'Um pipeline padrão por empresa (Kanban/listas ao abrir CRM)';

ALTER TABLE public.crm_stages
  ADD COLUMN IF NOT EXISTS inicial boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.crm_stages.inicial IS 'Estágio inicial de entrada de leads neste pipeline (no máx. um ativo por pipeline)';

ALTER TABLE public.crm_atividades
  ADD COLUMN IF NOT EXISTS data_fim timestamptz,
  ADD COLUMN IF NOT EXISTS participantes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS timezone varchar(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN IF NOT EXISTS google_html_link text;

COMMENT ON COLUMN public.crm_atividades.participantes IS 'JSON array: [{ "email": "a@b.com", "nome": "Opcional" }]';
COMMENT ON COLUMN public.crm_atividades.google_html_link IS 'URL do evento no Google Calendar (retorno da API)';

-- Backfill: um pipeline padrão por empresa (menor ordem)
UPDATE public.crm_pipelines p
SET padrao = true
FROM (
  SELECT DISTINCT ON (company_id) id
  FROM public.crm_pipelines
  ORDER BY company_id, ordem ASC, id ASC
) sub
WHERE p.id = sub.id;

-- Backfill: estágio inicial = primeiro estágio aberto por pipeline
UPDATE public.crm_stages s
SET inicial = true
FROM (
  SELECT DISTINCT ON (pipeline_id) id
  FROM public.crm_stages
  WHERE tipo_fechamento IS NULL AND ativo = true
  ORDER BY pipeline_id, ordem ASC, id ASC
) sub
WHERE s.id = sub.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_pipelines_one_padrao_por_empresa
  ON public.crm_pipelines (company_id)
  WHERE padrao = true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_stages_one_inicial_por_pipeline
  ON public.crm_stages (pipeline_id)
  WHERE inicial = true AND ativo = true;

CREATE INDEX IF NOT EXISTS idx_crm_atividades_company_agenda_status
  ON public.crm_atividades (company_id, status, data_agendada);
