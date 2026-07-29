-- Garantir coluna status em mensagens (✓✓ ticks no frontend)
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS status text;

COMMENT ON COLUMN public.mensagens.status IS 'Status da mensagem no WhatsApp: PENDING, SENT, RECEIVED, READ, PLAYED. Atualizado pelo webhook Z-API status.';
