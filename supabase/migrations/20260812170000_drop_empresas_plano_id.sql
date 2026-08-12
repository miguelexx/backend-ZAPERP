-- =====================================================
-- Follow-up da remocao do codigo de planos (sistema sem billing).
--
-- A tabela public.planos foi dropada na migration 20260812160000_drop_planos.sql,
-- mantendo por seguranca a coluna public.empresas.plano_id (nullable, sem FK).
--
-- Com o backend ja sem uso de plano_id (removidos GET /config/planos e o
-- tratamento de plano_id no PUT /config/empresa), a coluna deixou de ter
-- qualquer proposito e pode ser removida.
-- =====================================================

BEGIN;

ALTER TABLE public.empresas DROP COLUMN IF EXISTS plano_id;

COMMIT;
