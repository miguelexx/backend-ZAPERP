-- Configurações IA/Bot por empresa
CREATE TABLE IF NOT EXISTS public.ia_config (
  id serial PRIMARY KEY,
  company_id integer NOT NULL UNIQUE REFERENCES public.empresas(id),
  config jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT ia_config_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);

COMMENT ON TABLE public.ia_config IS 'Configurações globais de Bot/IA/Automações por empresa';

-- Regras de resposta automática (palavra-chave -> resposta)
CREATE TABLE IF NOT EXISTS public.regras_automaticas (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id),
  palavra_chave varchar(255) NOT NULL,
  resposta text NOT NULL,
  departamento_id integer REFERENCES public.departamentos(id),
  tag_id integer REFERENCES public.tags(id),
  aplicar_tag boolean DEFAULT false,
  horario_comercial_only boolean DEFAULT false,
  ativo boolean DEFAULT true,
  criado_em timestamptz DEFAULT now(),
  CONSTRAINT regras_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);

COMMENT ON TABLE public.regras_automaticas IS 'Regras palavra-chave -> resposta automática';

-- Logs do bot para auditoria
CREATE TABLE IF NOT EXISTS public.bot_logs (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id),
  conversa_id integer REFERENCES public.conversas(id),
  tipo varchar(50) NOT NULL,
  detalhes jsonb DEFAULT '{}',
  criado_em timestamptz DEFAULT now(),
  CONSTRAINT bot_logs_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);

COMMENT ON TABLE public.bot_logs IS 'Logs de ações do bot, respostas automáticas e erros';
