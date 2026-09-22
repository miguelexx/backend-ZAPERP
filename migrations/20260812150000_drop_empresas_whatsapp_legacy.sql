-- =====================================================
-- Remove public.empresas_whatsapp — legado da API Oficial do WhatsApp (Meta Cloud API).
--
-- Mapeava company_id -> phone_number_id (terminologia da Cloud API do Meta).
-- O sistema hoje envia via Z-API/UltraMsg (public.empresa_zapi, instancias ativas),
-- entao esse mapeamento nao e mais usado. Tabela com 0 linhas.
--
-- Todos os acessos no codigo sao defensivos (retornam []/null se a tabela sumir):
--   - configController.getEmpresasWhatsapp / postEmpresasWhatsapp / deleteEmpresasWhatsapp
--   - chatController (~6190): leitura de phone_number_id dentro de try/catch, phoneId=null OK
-- Sem FK de entrada, sem trigger/funcao. Codigo Node sera removido em sessao separada.
-- =====================================================

BEGIN;

DROP TABLE IF EXISTS public.empresas_whatsapp;

COMMIT;
