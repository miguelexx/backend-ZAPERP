-- Metadados estruturados para mensagens tipo localização (CRM + espelhamento WhatsApp)
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS location_meta jsonb DEFAULT NULL;

COMMENT ON COLUMN public.mensagens.location_meta IS 'Localização: { latitude, longitude, nome?, endereco? }. Usado com tipo=location.';
