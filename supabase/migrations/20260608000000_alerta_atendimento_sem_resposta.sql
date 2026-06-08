-- Alerta de Atendimento Sem Resposta
-- Estado idempotente por conversa + eventos auditaveis por empresa.

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS ultima_mensagem_cliente_em timestamptz,
  ADD COLUMN IF NOT EXISTS ultima_resposta_atendente_em timestamptz,
  ADD COLUMN IF NOT EXISTS sla_status text DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS primeiro_alerta_enviado_em timestamptz,
  ADD COLUMN IF NOT EXISTS alerta_critico_enviado_em timestamptz,
  ADD COLUMN IF NOT EXISTS gestor_notificado_em timestamptz,
  ADD COLUMN IF NOT EXISTS conversa_reaberta_por_sla_em timestamptz,
  ADD COLUMN IF NOT EXISTS atendente_original_id integer,
  ADD COLUMN IF NOT EXISTS motivo_reabertura text,
  ADD COLUMN IF NOT EXISTS tag_aplicada_por_sla boolean DEFAULT false;

COMMENT ON COLUMN public.conversas.ultima_mensagem_cliente_em IS
  'Ultima mensagem inbound elegivel para alerta de atendimento sem resposta.';
COMMENT ON COLUMN public.conversas.ultima_resposta_atendente_em IS
  'Ultima mensagem outbound humana usada para resetar o SLA sem resposta.';
COMMENT ON COLUMN public.conversas.sla_status IS
  'Status do alerta sem resposta: normal, atencao, critico, gestor_notificado, reaberta_por_falta_de_resposta, assumida_apos_reabertura.';

CREATE TABLE IF NOT EXISTS public.alerta_sem_resposta_eventos (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  conversa_id integer NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  atendente_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  gestor_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  tipo text NOT NULL,
  nivel text,
  minutos_sem_resposta integer,
  ultima_mensagem_cliente_em timestamptz,
  mensagem text,
  detalhes jsonb NOT NULL DEFAULT '{}',
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerta_sem_resposta_evento_etapa
  ON public.alerta_sem_resposta_eventos (company_id, conversa_id, tipo, ultima_mensagem_cliente_em)
  WHERE ultima_mensagem_cliente_em IS NOT NULL;

-- Apoio para FKs compostas multiempresa. Como `id` ja e unico nessas tabelas,
-- estes indices nao mudam cardinalidade; apenas permitem validar company_id junto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversas_company_id_id
  ON public.conversas (company_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_alerta_sem_resposta_eventos_conversa_empresa'
  ) THEN
    ALTER TABLE public.alerta_sem_resposta_eventos
      ADD CONSTRAINT fk_alerta_sem_resposta_eventos_conversa_empresa
      FOREIGN KEY (company_id, conversa_id)
      REFERENCES public.conversas (company_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alerta_sem_resposta_eventos_company_criado
  ON public.alerta_sem_resposta_eventos (company_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_alerta_sem_resposta_eventos_conversa
  ON public.alerta_sem_resposta_eventos (conversa_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_conversas_alerta_sem_resposta_scan
  ON public.conversas (company_id, status_atendimento, ultima_mensagem_cliente_em, atendente_id)
  WHERE status_atendimento = 'em_atendimento'::text
    AND atendente_id IS NOT NULL
    AND ultima_mensagem_cliente_em IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mensagens_company_conversa_criado_id
  ON public.mensagens (company_id, conversa_id, criado_em DESC, id DESC);
