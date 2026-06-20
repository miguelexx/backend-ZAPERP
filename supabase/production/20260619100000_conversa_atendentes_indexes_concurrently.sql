-- Versao para aplicar manualmente em producao grande, uma instrucao por vez.
-- A tabela deve existir antes destes indices. CREATE INDEX CONCURRENTLY nao pode rodar dentro de transaction block.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS conversa_atendentes_active_unique
  ON public.conversa_atendentes (company_id, conversa_id, usuario_id)
  WHERE ativo = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversa_atendentes_usuario_active
  ON public.conversa_atendentes (company_id, usuario_id, conversa_id)
  WHERE ativo = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversa_atendentes_conversa_active
  ON public.conversa_atendentes (company_id, conversa_id, usuario_id)
  WHERE ativo = true;
