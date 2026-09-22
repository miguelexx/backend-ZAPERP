-- Identificação do solicitante externo e simplificação do fluxo de status.
ALTER TABLE public.helpdesk_tickets
  ADD COLUMN IF NOT EXISTS empresa_nome varchar(180),
  ADD COLUMN IF NOT EXISTS cnpj varchar(18),
  ADD COLUMN IF NOT EXISTS solicitante_nome varchar(180),
  ADD COLUMN IF NOT EXISTS telefone varchar(30);

UPDATE public.helpdesk_tickets SET status = 'em_atendimento' WHERE status = 'aguardando';
UPDATE public.helpdesk_tickets SET status = 'resolvido' WHERE status = 'fechado';

ALTER TABLE public.helpdesk_tickets DROP CONSTRAINT IF EXISTS helpdesk_tickets_status_check;
ALTER TABLE public.helpdesk_tickets
  ADD CONSTRAINT helpdesk_tickets_status_check
  CHECK (status IN ('aberto', 'em_atendimento', 'resolvido'));

CREATE INDEX IF NOT EXISTS helpdesk_tickets_company_empresa_idx
  ON public.helpdesk_tickets (company_id, empresa_nome);
CREATE INDEX IF NOT EXISTS helpdesk_tickets_company_cnpj_idx
  ON public.helpdesk_tickets (company_id, cnpj);
CREATE INDEX IF NOT EXISTS helpdesk_tickets_company_created_idx
  ON public.helpdesk_tickets (company_id, criado_em DESC);
