-- Índices sugeridos para melhorar filtros/listagens de conversas e mensagens
-- Aplicar em janela de manutenção, preferencialmente com CONCURRENTLY.
-- Não altera regra de negócio, apenas acelera consultas existentes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_company_atividade
  ON conversas (company_id, ultima_atividade DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_company_status_atendente
  ON conversas (company_id, status_atendimento, atendente_id, ultima_atividade DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_company_telefone
  ON conversas (company_id, telefone);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_company_chat_lid
  ON conversas (company_id, chat_lid);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_company_conversa_data
  ON mensagens (company_id, conversa_id, criado_em DESC, id DESC);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_company_whatsapp_unique
  ON mensagens (company_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_out_sem_whatsapp
  ON mensagens (company_id, conversa_id, direcao, criado_em DESC)
  WHERE whatsapp_id IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversa_tags_company_tag_conversa
  ON conversa_tags (company_id, tag_id, conversa_id);

-- Busca textual (requer extensão pg_trgm)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_texto_trgm
  ON mensagens USING gin (texto gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_nome_trgm
  ON clientes USING gin (nome gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_pushname_trgm
  ON clientes USING gin (pushname gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_telefone_trgm
  ON clientes USING gin (telefone gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_nome_grupo_trgm
  ON conversas USING gin (nome_grupo gin_trgm_ops);
