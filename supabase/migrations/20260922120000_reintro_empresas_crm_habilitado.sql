-- =====================================================
-- Re-introduz public.empresas.crm_habilitado (flag POR EMPRESA).
--
-- Contexto: a coluna foi removida em 20260812130000 quando o CRM interno saiu,
-- mas o CRM Avançado (SSO + sync) trouxe de volta o botão «Enviar ao CRM» no
-- chat. As Configurações já expõem o toggle "Módulo CRM para a empresa", porém
-- ele estava inerte (putEmpresa não gravava e não havia coluna).
--
-- Semântica: o CRM só aparece/atende quando o AMBIENTE está configurado
-- (crmSyncService.isEnabled() — envs CRM_API_URL/ZAP_SSO_SECRET) E esta flag
-- está ligada. Default true: empresas existentes seguem como estão.
--
-- Idempotente. Aplicar ANTES do deploy do backend.
-- =====================================================

BEGIN;

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS crm_habilitado boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.empresas.crm_habilitado IS
  'Liga/desliga o módulo CRM (botão «Enviar ao CRM» + APIs de CRM) por empresa. Complementar ao interruptor por ambiente (CRM_API_URL/ZAP_SSO_SECRET). Default true.';

COMMIT;
