BEGIN;

ALTER TABLE public.helpdesk_tickets
  ADD COLUMN IF NOT EXISTS sistema_operacional varchar(120),
  ADD COLUMN IF NOT EXISTS nome_maquina varchar(120),
  ADD COLUMN IF NOT EXISTS versao_sistema varchar(120);

COMMIT;

SELECT
  column_name,
  data_type,
  character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'helpdesk_tickets'
  AND column_name IN (
    'sistema_operacional',
    'nome_maquina',
    'versao_sistema'
  )
ORDER BY column_name;
