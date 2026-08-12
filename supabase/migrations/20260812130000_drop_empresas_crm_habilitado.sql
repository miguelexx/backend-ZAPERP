-- =====================================================
-- Follow-up da remocao do modulo CRM legado.
--
-- Remove a coluna public.empresas.crm_habilitado, que so servia para
-- ligar/desligar o modulo CRM por tenant. Com o CRM removido do codigo
-- (controllers/services/routes/repositories) e das tabelas crm_*
-- (migration 20260812120000), a flag deixou de ter uso.
--
-- Backend: userController fixa crm_habilitado:false no retorno e
-- configController parou de aceitar o campo no PUT /config/empresa.
--
-- NAO mexer em tags.ativo / tags.atualizado_em: a tabela tags e
-- compartilhada com o fluxo de conversas.
-- =====================================================

BEGIN;

ALTER TABLE public.empresas DROP COLUMN IF EXISTS crm_habilitado;

COMMIT;
