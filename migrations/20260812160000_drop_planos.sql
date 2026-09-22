-- =====================================================
-- Remove public.planos — sistema nao e cobrado por planos (sem billing).
--
-- Verificado em 2026-08-12: os limites (limite_atendentes/conversas/mensagens)
-- NAO sao enforcados em lugar nenhum do backend. A tabela so era lida pelo
-- endpoint GET /config/planos (listagem). empresas.plano_id tem FK -> planos.
--
-- Estrategia segura: remove a FK e a tabela. A coluna empresas.plano_id e
-- MANTIDA (nullable, sem FK) para nao quebrar o save de configuracoes que ainda
-- referencia plano_id no configController; ela pode ser removida depois, junto
-- com a limpeza de codigo (ver docs/PROMPT-remover-codigo-planos.md).
--
-- IMPORTANTE: aplique junto com a limpeza de codigo, senao GET /config/planos
-- passa a retornar erro (a tabela nao existe mais).
-- =====================================================

BEGIN;

ALTER TABLE public.empresas DROP CONSTRAINT IF EXISTS empresas_plano_id_fkey;
DROP TABLE IF EXISTS public.planos;

COMMIT;
