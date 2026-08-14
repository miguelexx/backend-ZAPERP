BEGIN;

ALTER TABLE public.helpdesk_tickets
  ADD COLUMN IF NOT EXISTS empresa_razao varchar(180),
  ADD COLUMN IF NOT EXISTS sistema_operacional varchar(120),
  ADD COLUMN IF NOT EXISTS nome_maquina varchar(120),
  ADD COLUMN IF NOT EXISTS versao_sistema varchar(120),
  ADD COLUMN IF NOT EXISTS memoria_ram_bytes bigint,
  ADD COLUMN IF NOT EXISTS processador_nome varchar(180),
  ADD COLUMN IF NOT EXISTS processadores_logicos integer,
  ADD COLUMN IF NOT EXISTS tempo_atividade_segundos bigint,
  ADD COLUMN IF NOT EXISTS espaco_disponivel_disco_c_bytes bigint,
  ADD COLUMN IF NOT EXISTS espaco_total_disco_c_bytes bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.helpdesk_tickets'::regclass
      AND conname = 'helpdesk_tickets_ambiente_numeros_check'
  ) THEN
    ALTER TABLE public.helpdesk_tickets
      ADD CONSTRAINT helpdesk_tickets_ambiente_numeros_check CHECK (
        (memoria_ram_bytes IS NULL OR memoria_ram_bytes >= 0)
        AND (processadores_logicos IS NULL OR processadores_logicos > 0)
        AND (tempo_atividade_segundos IS NULL OR tempo_atividade_segundos >= 0)
        AND (espaco_disponivel_disco_c_bytes IS NULL OR espaco_disponivel_disco_c_bytes >= 0)
        AND (espaco_total_disco_c_bytes IS NULL OR espaco_total_disco_c_bytes >= 0)
        AND (
          espaco_disponivel_disco_c_bytes IS NULL
          OR espaco_total_disco_c_bytes IS NULL
          OR espaco_disponivel_disco_c_bytes <= espaco_total_disco_c_bytes
        )
      );
  END IF;
END
$$;

COMMIT;

SELECT
  column_name,
  data_type,
  character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'helpdesk_tickets'
  AND column_name IN (
    'empresa_razao',
    'sistema_operacional',
    'nome_maquina',
    'versao_sistema',
    'memoria_ram_bytes',
    'processador_nome',
    'processadores_logicos',
    'tempo_atividade_segundos',
    'espaco_disponivel_disco_c_bytes',
    'espaco_total_disco_c_bytes'
  )
ORDER BY column_name;
