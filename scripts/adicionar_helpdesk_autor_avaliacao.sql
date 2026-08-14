BEGIN;

ALTER TABLE public.helpdesk_mensagens
  ADD COLUMN IF NOT EXISTS solicitante_nome varchar(180);

ALTER TABLE public.helpdesk_tickets
  ADD COLUMN IF NOT EXISTS avaliacao smallint;

UPDATE public.helpdesk_tickets
SET avaliacao = 0
WHERE avaliacao IS NULL;

ALTER TABLE public.helpdesk_tickets
  ALTER COLUMN avaliacao SET DEFAULT 0,
  ALTER COLUMN avaliacao SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.helpdesk_tickets'::regclass
      AND conname = 'helpdesk_tickets_avaliacao_check'
  ) THEN
    ALTER TABLE public.helpdesk_tickets
      ADD CONSTRAINT helpdesk_tickets_avaliacao_check
      CHECK (avaliacao BETWEEN 0 AND 5);
  END IF;
END
$$;

COMMIT;

SELECT
  table_name,
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'helpdesk_mensagens' AND column_name = 'solicitante_nome')
    OR (table_name = 'helpdesk_tickets' AND column_name = 'avaliacao')
  )
ORDER BY table_name, column_name;
