-- ============================================================
-- UNIQUE em clientes(company_id, telefone)
-- Garante 1 cliente por contato por empresa.
-- Se migration falhar com "duplicate key", rode dedupe (POST /chats/merge-duplicatas)
-- e scripts/certificacao/auditoria-duplicados.sql antes.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_company_telefone_unique
  ON public.clientes (company_id, telefone);

COMMENT ON INDEX public.idx_clientes_company_telefone_unique IS
  'Garante 1 cliente por (empresa, telefone). Evita duplicação ao receber webhooks Z-API.';
