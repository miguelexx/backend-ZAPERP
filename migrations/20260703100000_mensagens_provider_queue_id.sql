-- Adiciona coluna provider_queue_id à tabela mensagens.
-- Separa o ID de fila interno do provedor (ex: "35096" da UltraMsg) do whatsapp_id real.
-- whatsapp_id continua guardando apenas IDs reais do WhatsApp (formato false_PHONE_HEXID).
-- provider_queue_id permite reconciliação de ACKs quando o ID real ainda não chegou.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS provider_queue_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_mensagens_provider_queue_id
  ON public.mensagens (company_id, provider_queue_id)
  WHERE provider_queue_id IS NOT NULL;

COMMENT ON COLUMN public.mensagens.provider_queue_id
  IS 'ID de fila interno do provedor (ex: UltraMsg numérico "35096"). Usado para reconciliar ACKs antes do whatsapp_id real chegar.';
