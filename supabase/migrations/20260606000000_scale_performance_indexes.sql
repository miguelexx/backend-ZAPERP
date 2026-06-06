-- Indices adicionais para escala (70+ empresas, alto volume de mensagens/realtime).
-- Aplicar em janela de baixa movimentacao se o banco ja tiver muito volume.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Listas e buscas de contatos.
CREATE INDEX IF NOT EXISTS idx_clientes_company_nome_id
  ON public.clientes (company_id, nome, id);

CREATE INDEX IF NOT EXISTS idx_clientes_company_pushname_id
  ON public.clientes (company_id, pushname, id);

CREATE INDEX IF NOT EXISTS idx_clientes_nome_trgm
  ON public.clientes USING gin (nome gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_clientes_pushname_trgm
  ON public.clientes USING gin (pushname gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_clientes_telefone_trgm
  ON public.clientes USING gin (telefone gin_trgm_ops);

-- Busca por nome de grupo na lista de conversas.
CREATE INDEX IF NOT EXISTS idx_conversas_nome_grupo_trgm
  ON public.conversas USING gin (nome_grupo gin_trgm_ops);

-- Filtros de tags em conversas.
CREATE INDEX IF NOT EXISTS idx_conversa_tags_company_tag_conversa
  ON public.conversa_tags (company_id, tag_id, conversa_id);

-- Reconciliacao de mensagens enviadas pelo CRM antes do whatsapp_id chegar.
CREATE INDEX IF NOT EXISTS idx_mensagens_out_sem_whatsapp
  ON public.mensagens (company_id, conversa_id, direcao, criado_em DESC, id DESC)
  WHERE whatsapp_id IS NULL;

-- Filtros que verificam se uma conversa ja recebeu mensagem inbound.
CREATE INDEX IF NOT EXISTS idx_mensagens_company_conversa_in
  ON public.mensagens (company_id, conversa_id)
  WHERE direcao = 'in';

-- Auditoria e relatorios operacionais.
CREATE INDEX IF NOT EXISTS idx_atendimentos_company_criado_id
  ON public.atendimentos (company_id, criado_em DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_historico_atendimentos_conversa_criado_id
  ON public.historico_atendimentos (conversa_id, criado_em DESC, id DESC);

DO $$
BEGIN
  IF to_regclass('public.webhook_logs') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_company_criado_id
      ON public.webhook_logs (company_id, criado_em DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_webhook_logs_provider_status_criado
      ON public.webhook_logs (provider, status, criado_em DESC);
  END IF;
END $$;
