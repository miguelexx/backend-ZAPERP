-- Auditoria de envios WhatsApp.
-- A aplicacao opera em modo monitor por padrao: esta tabela mede risco sem bloquear mensagens.

CREATE TABLE IF NOT EXISTS public.whatsapp_envio_guard_logs (
  id bigserial PRIMARY KEY,
  company_id integer REFERENCES public.empresas(id) ON DELETE SET NULL,
  conversa_id integer REFERENCES public.conversas(id) ON DELETE SET NULL,
  endpoint varchar(80) NOT NULL,
  tipo varchar(50),
  origem varchar(120) DEFAULT 'nao_informado',
  origem_tipo varchar(30) DEFAULT 'unknown',
  risco varchar(20) DEFAULT 'medium',
  modo varchar(20) DEFAULT 'monitor',
  acao varchar(30) DEFAULT 'allow',
  motivos jsonb DEFAULT '[]'::jsonb,
  delay_ms integer DEFAULT 0,
  destino_tail varchar(30),
  destino_hash varchar(64),
  texto_tamanho integer,
  arquivo_tamanho integer,
  status_http integer,
  sucesso boolean,
  message_id varchar(220),
  erro text,
  duracao_ms integer,
  criado_em timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_envio_guard_company_criado
  ON public.whatsapp_envio_guard_logs(company_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_envio_guard_company_origem
  ON public.whatsapp_envio_guard_logs(company_id, origem_tipo, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_envio_guard_company_sucesso
  ON public.whatsapp_envio_guard_logs(company_id, sucesso, criado_em DESC);

COMMENT ON TABLE public.whatsapp_envio_guard_logs IS
  'Auditoria de envios WhatsApp para monitoramento de risco, volume, automacoes e falhas.';
