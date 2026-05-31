-- Indices de suporte para lista de conversas, realtime por setor e abertura de chat.
-- Nao altera regras de negocio; apenas reduz custo de filtros e verificacoes recorrentes.

CREATE INDEX IF NOT EXISTS idx_conversas_company_atividade_id
  ON public.conversas (company_id, ultima_atividade DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_conversas_company_status_atendente_atividade
  ON public.conversas (company_id, status_atendimento, atendente_id, ultima_atividade DESC);

CREATE INDEX IF NOT EXISTS idx_conversas_company_departamento_atividade
  ON public.conversas (company_id, departamento_id, ultima_atividade DESC);

CREATE INDEX IF NOT EXISTS idx_mensagens_company_conversa_criado_id
  ON public.mensagens (company_id, conversa_id, criado_em DESC, id DESC);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_mensagens_texto_trgm
  ON public.mensagens USING gin (texto gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_atendimentos_company_conversa_acao_de_usuario
  ON public.atendimentos (company_id, conversa_id, acao, de_usuario_id);

CREATE INDEX IF NOT EXISTS idx_usuario_departamentos_company_usuario_departamento
  ON public.usuario_departamentos (company_id, usuario_id, departamento_id);

CREATE INDEX IF NOT EXISTS idx_usuario_departamentos_company_departamento_usuario
  ON public.usuario_departamentos (company_id, departamento_id, usuario_id);

DO $$
BEGIN
  IF to_regclass('public.mensagens_ocultas') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_mensagens_ocultas_lookup
      ON public.mensagens_ocultas (company_id, conversa_id, usuario_id, mensagem_id);
  END IF;
END $$;
