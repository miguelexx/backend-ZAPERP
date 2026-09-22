-- Fotos de perfil (contato e grupo) para integrar dados do celular
-- clientes: foto do perfil do contato (Z-API photo/senderPhoto)
-- conversas: foto do grupo (quando disponível no payload ou API)

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS foto_perfil text;

COMMENT ON COLUMN public.clientes.foto_perfil IS 'URL da foto de perfil do contato (WhatsApp/Z-API). Pode expirar em 48h.';

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS foto_grupo text;

COMMENT ON COLUMN public.conversas.foto_grupo IS 'URL da foto do grupo (quando tipo=grupo).';
