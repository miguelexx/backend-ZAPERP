BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'helpdesk_tickets'
      AND column_name = 'departamento_id'
  ) THEN
    ALTER TABLE public.helpdesk_tickets
      ADD COLUMN IF NOT EXISTS departamento text;

    UPDATE public.helpdesk_tickets AS ticket
    SET departamento = departamento.nome
    FROM public.departamentos AS departamento
    WHERE departamento.id = ticket.departamento_id
      AND departamento.company_id = ticket.company_id
      AND ticket.departamento IS NULL;

    ALTER TABLE public.helpdesk_tickets
      DROP CONSTRAINT IF EXISTS helpdesk_tickets_departamento_id_fkey;

    ALTER TABLE public.helpdesk_tickets
      DROP COLUMN departamento_id;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS helpdesk_tickets_company_departamento_idx
  ON public.helpdesk_tickets (company_id, departamento);

COMMIT;
