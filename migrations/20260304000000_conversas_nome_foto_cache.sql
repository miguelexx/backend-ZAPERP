-- Cache de nome e foto do contato quando a conversa é LID (sem cliente vinculado).
-- Preenchido pelo webhook Z-API ao receber fromMe com chatName/photo; usado na listagem até haver cliente_id.

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS nome_contato_cache text,
  ADD COLUMN IF NOT EXISTS foto_perfil_contato_cache text;

COMMENT ON COLUMN public.conversas.nome_contato_cache IS 'Nome do contato (ex.: chatName do Z-API) quando conversa é LID e ainda não tem cliente_id.';
COMMENT ON COLUMN public.conversas.foto_perfil_contato_cache IS 'URL da foto de perfil do contato quando conversa é LID e ainda não tem cliente_id.';
