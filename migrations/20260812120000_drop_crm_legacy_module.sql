-- =====================================================
-- Remove o modulo CRM legado deste backend.
--
-- Contexto: o CRM avancado passa a viver em projeto separado. As tabelas
-- crm_* deste backend nao serao mais usadas. Remocao aprovada em 2026-08-12
-- (drop direto, sem backup — dados considerados descartaveis).
--
-- Escopo: 13 tabelas em producao (+ crm_timeline, caso exista em algum
-- ambiente), a view crm_loss_reasons e as 6 funcoes de trigger crm_enforce_*.
-- Nenhuma tabela nao-CRM referencia essas tabelas (verificado), entao o
-- CASCADE nao afeta o nucleo (conversas, mensagens, clientes, usuarios...).
--
-- ATENCAO: IRREVERSIVEL. Apaga dados (ex.: crm_stages, crm_leads, crm_pipelines).
--
-- Nao removido aqui de proposito (fica para a sessao de limpeza de codigo):
--   - coluna public.empresas.crm_habilitado
--   - colunas public.tags.ativo / public.tags.atualizado_em (tags e compartilhada)
--   - codigo Node do CRM (controllers/services/routes/repositories)
-- =====================================================

BEGIN;

-- 1) View dependente de crm_lost_reasons
DROP VIEW IF EXISTS public.crm_loss_reasons;

-- 2) Tabelas (CASCADE resolve as FKs entre elas e remove os triggers)
DROP TABLE IF EXISTS
  public.crm_webhook_logs_google,
  public.crm_google_tokens,
  public.crm_stage_movements,
  public.crm_lead_tags,
  public.crm_atividades,
  public.crm_notas,
  public.crm_timeline,
  public.crm_campaigns,
  public.crm_leads,
  public.crm_stages,
  public.crm_pipelines,
  public.crm_origens,
  public.crm_lost_reasons,
  public.crm_config
CASCADE;

-- 3) Funcoes de trigger orfas (os triggers ja cairam junto com as tabelas)
DROP FUNCTION IF EXISTS public.crm_enforce_lead_consistency() CASCADE;
DROP FUNCTION IF EXISTS public.crm_enforce_lead_tag_consistency() CASCADE;
DROP FUNCTION IF EXISTS public.crm_enforce_atividade_consistency() CASCADE;
DROP FUNCTION IF EXISTS public.crm_enforce_nota_consistency() CASCADE;
DROP FUNCTION IF EXISTS public.crm_enforce_timeline_consistency() CASCADE;
DROP FUNCTION IF EXISTS public.crm_enforce_campaign_consistency() CASCADE;

COMMIT;
