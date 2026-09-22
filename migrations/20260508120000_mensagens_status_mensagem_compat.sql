-- Compatibilidade de schema para payload/socket legado (status_mensagem).
-- Mantém fluxo atual funcionando sem impactar integrações existentes.
BEGIN;

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS status_mensagem text DEFAULT 'pending';

UPDATE public.mensagens
SET status_mensagem = COALESCE(NULLIF(status, ''), 'pending')
WHERE status_mensagem IS NULL OR status_mensagem = '';

COMMIT;
