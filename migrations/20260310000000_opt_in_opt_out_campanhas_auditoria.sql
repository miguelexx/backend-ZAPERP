-- =====================================================
-- Opt-in, Opt-out, Campanhas, Auditoria e Proteção
-- Migração para conformidade operacional e campanhas
-- =====================================================

-- 1) contato_opt_in — consentimento para envio comercial
CREATE TABLE IF NOT EXISTS public.contato_opt_in (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id integer NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  origem varchar(50) DEFAULT 'manual',
  ativo boolean DEFAULT true,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now(),
  UNIQUE(company_id, cliente_id)
);
CREATE INDEX IF NOT EXISTS idx_contato_opt_in_company_cliente ON public.contato_opt_in(company_id, cliente_id);
CREATE INDEX IF NOT EXISTS idx_contato_opt_in_company_ativo ON public.contato_opt_in(company_id, ativo);
COMMENT ON TABLE public.contato_opt_in IS 'Opt-in: contatos que aceitaram receber mensagens comerciais';

-- 2) contato_opt_out — descadastro/comando PARAR
CREATE TABLE IF NOT EXISTS public.contato_opt_out (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id integer REFERENCES public.clientes(id) ON DELETE SET NULL,
  telefone varchar(30),
  motivo varchar(100),
  canal varchar(50),
  criado_em timestamptz DEFAULT now(),
  CONSTRAINT contato_opt_out_cliente_or_telefone CHECK (cliente_id IS NOT NULL OR telefone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_contato_opt_out_company_cliente ON public.contato_opt_out(company_id, cliente_id) WHERE cliente_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contato_opt_out_company_telefone ON public.contato_opt_out(company_id, telefone) WHERE telefone IS NOT NULL;
COMMENT ON TABLE public.contato_opt_out IS 'Opt-out: contatos que pediram descadastro (PARAR, SAIR, etc.)';

-- 3) campanhas — envios em massa (rascunho, em_andamento, pausada)
CREATE TABLE IF NOT EXISTS public.campanhas (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nome varchar(255) NOT NULL,
  tipo varchar(50) DEFAULT 'promocional',
  texto_template text NOT NULL,
  filtros_json jsonb DEFAULT '{}',
  status varchar(30) DEFAULT 'rascunho',
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campanhas_company_status ON public.campanhas(company_id, status);
COMMENT ON TABLE public.campanhas IS 'Campanhas de envio em massa (requer opt-in e respeita opt-out)';

-- 4) campanha_envios — registro de cada envio por contato
CREATE TABLE IF NOT EXISTS public.campanha_envios (
  id serial PRIMARY KEY,
  campanha_id integer NOT NULL REFERENCES public.campanhas(id) ON DELETE CASCADE,
  cliente_id integer NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  status varchar(30) DEFAULT 'pendente',
  enviado_em timestamptz,
  erro text,
  criado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campanha_envios_campanha ON public.campanha_envios(campanha_id);
CREATE INDEX IF NOT EXISTS idx_campanha_envios_cliente ON public.campanha_envios(campanha_id, cliente_id);
COMMENT ON TABLE public.campanha_envios IS 'Registro de envios por campanha e contato';

-- 5) auditoria_log — ações críticas (campanha, permissões, etc.)
CREATE TABLE IF NOT EXISTS public.auditoria_log (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  acao varchar(100) NOT NULL,
  entidade varchar(100),
  entidade_id integer,
  detalhes_json jsonb DEFAULT '{}',
  criado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_log_company_criado ON public.auditoria_log(company_id, criado_em DESC);
COMMENT ON TABLE public.auditoria_log IS 'Log de ações críticas: campanha_criar/excluir, permissoes_alterar, etc.';

-- 6) Colunas de proteção em empresas (intervalo, limite volume)
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS intervalo_minimo_entre_mensagens_seg integer DEFAULT 0;
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS limite_por_minuto integer DEFAULT 0;
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS limite_por_hora integer DEFAULT 0;
COMMENT ON COLUMN public.empresas.intervalo_minimo_entre_mensagens_seg IS 'Proteção: segundos entre mensagens ao mesmo contato. 0 = desativado';
COMMENT ON COLUMN public.empresas.limite_por_minuto IS 'Proteção: máximo de mensagens enviadas por minuto. 0 = desativado';
COMMENT ON COLUMN public.empresas.limite_por_hora IS 'Proteção: máximo de mensagens enviadas por hora. 0 = desativado';
