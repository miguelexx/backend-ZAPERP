DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname
    INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.atendimentos'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%acao%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.atendimentos DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE public.atendimentos
    ADD CONSTRAINT atendimentos_acao_check
    CHECK (
      acao = ANY (
        ARRAY[
          'assumiu'::text,
          'transferiu'::text,
          'encerrou'::text,
          'reabriu'::text,
          'transferiu_setor'::text,
          'adicionou_atendente'::text
        ]
      )
    );
END $$;
