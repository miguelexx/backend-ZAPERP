-- =====================================================================
-- Aceitar provider 'whapi' em whatsapp_instances (2ª integração WhatsApp).
-- ADITIVA: não altera nenhuma linha existente; NÃO cria colunas novas de credencial.
-- Reusa os campos que já existem (mesmo registro / mesma tabela):
--   provider        = 'ultramsg' | 'whapi'
--   instance_id     = UltraMSG instanceNNNN  |  Whapi channel_id (ex. NEBULA-AER3B)
--   instance_token  = token UltraMSG         |  Bearer Whapi
--   client_token    = só UltraMSG; Whapi deixa NULL
--   telefone_conectado / display_phone / status / metadata = iguais
-- NÃO criar whapi_token / whapi_id / whapi_channel_id — duplicaria o modelo e
-- quebraria getWhatsappInstanceByProviderInstanceId (webhook usa instance_id).
--
-- Default da empresa permanece ÚNICO (índice uq_whatsapp_instances_default_active
-- em company_id). Instância Whapi numa empresa que já tem UltraMSG default
-- entra com is_default=false. Conversas usam whatsapp_instance_id.
--
-- ORDEM: aplicar ANTES do deploy que faz INSERT provider='whapi'.
-- NÃO aplicada automaticamente — Miguel aplica.
-- Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
-- =====================================================================

BEGIN;

ALTER TABLE public.whatsapp_instances
  DROP CONSTRAINT IF EXISTS whatsapp_instances_provider_chk;

ALTER TABLE public.whatsapp_instances
  ADD CONSTRAINT whatsapp_instances_provider_chk
  CHECK (provider IN ('ultramsg', 'whapi'));

COMMENT ON CONSTRAINT whatsapp_instances_provider_chk ON public.whatsapp_instances
  IS 'Providers WhatsApp suportados. ultramsg = produção histórica; whapi = 2ª integração opcional por instância (doc 25). Mesma tabela; sem colunas paralelas de token.';

COMMENT ON COLUMN public.whatsapp_instances.provider IS
  'ultramsg (produção) ou whapi (2ª API opcional). Distingue como interpretar instance_id/instance_token.';

COMMENT ON COLUMN public.whatsapp_instances.instance_id IS
  'Identificador do canal no provider. UltraMSG: instanceNNNN. Whapi: channel_id (ex. NEBULA-AER3B).';

COMMENT ON COLUMN public.whatsapp_instances.instance_token IS
  'Segredo da API. UltraMSG token; Whapi Authorization Bearer. Nunca expor em respostas públicas.';

COMMENT ON COLUMN public.whatsapp_instances.client_token IS
  'Só UltraMSG. Instância Whapi permanece NULL.';

COMMIT;

-- Rollback (se necessário, e SÓ se nenhuma linha usar 'whapi'):
--   ALTER TABLE public.whatsapp_instances DROP CONSTRAINT IF EXISTS whatsapp_instances_provider_chk;
--   ALTER TABLE public.whatsapp_instances ADD CONSTRAINT whatsapp_instances_provider_chk CHECK (provider IN ('ultramsg'));
