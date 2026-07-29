-- Opção por empresa: separar no CRM mensagens enviadas pelo WhatsApp fora do ZapERP (status mensagem_disparada).
-- Idempotente: IF NOT EXISTS / DROP IF EXISTS seguros para produção.

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS separar_mensagens_disparadas boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresas.separar_mensagens_disparadas IS
  'Quando true, outbound fromMe originado fora do CRM (sem autor_usuario_id) classifica a conversa como mensagem_disparada em vez de aberta.';

-- Novo valor de workflow (sem UPDATE em massa em conversas antigas).
ALTER TABLE public.conversas DROP CONSTRAINT IF EXISTS conversas_status_atendimento_check;

ALTER TABLE public.conversas ADD CONSTRAINT conversas_status_atendimento_check
  CHECK (status_atendimento = ANY (ARRAY[
    'aberta'::text,
    'em_atendimento'::text,
    'aguardando_cliente'::text,
    'fechada'::text,
    'finalizada'::text,
    'mensagem_disparada'::text
  ]));

COMMENT ON CONSTRAINT conversas_status_atendimento_check ON public.conversas IS
  'Inclui mensagem_disparada: envios pelo WhatsApp fora do CRM (opcional por empresa).';

-- Lista / filtro por empresa + status (consultas com status_atendimento = mensagem_disparada).
CREATE INDEX IF NOT EXISTS idx_conversas_company_status_disparada
  ON public.conversas (company_id, ultima_atividade DESC)
  WHERE status_atendimento = 'mensagem_disparada'::text;
