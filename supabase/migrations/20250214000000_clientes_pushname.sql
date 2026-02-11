-- pushname = nome exibido no WhatsApp (notify); usado na sincronização Z-API
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS pushname text;

COMMENT ON COLUMN public.clientes.pushname IS 'Nome no WhatsApp (notify) vindo da Z-API. nome = pushname || name para exibição.';
