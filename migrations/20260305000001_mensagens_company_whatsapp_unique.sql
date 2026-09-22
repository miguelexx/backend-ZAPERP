-- Índice único adicional (company_id, whatsapp_id) para idempotência multi-tenant
-- Garante que a mesma mensagem WhatsApp nunca seja duplicada entre empresas.
-- Complementa idx_mensagens_conversa_whatsapp_id (conversa_id, whatsapp_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_company_whatsapp_id
  ON public.mensagens (company_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL AND whatsapp_id != '';
