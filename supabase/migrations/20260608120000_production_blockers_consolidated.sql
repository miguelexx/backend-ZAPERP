-- Consolidacao idempotente dos bloqueadores de producao identificados na auditoria.
-- Seguro para reexecutar: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ============================================================
-- 1) Alerta sem resposta (conversas + eventos)
-- ============================================================
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

-- ============================================================
-- 2) Apagar para todos
-- ============================================================
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS apagada_para_todos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS apagada_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_apagada
  ON public.mensagens (company_id, conversa_id, apagada_para_todos)
  WHERE apagada_para_todos = true;

-- ============================================================
-- 3) Push VAPID + dedup inbound
-- ============================================================
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_endpoint_uq UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_company_user
  ON public.push_subscriptions (company_id, usuario_id);

CREATE TABLE IF NOT EXISTS public.push_inbound_delivery_log (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL,
  mensagem_id text NOT NULL,
  usuario_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_inbound_delivery_log_uq UNIQUE (mensagem_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_push_inbound_delivery_log_created
  ON public.push_inbound_delivery_log (created_at DESC);

-- ============================================================
-- 4) Guard de envio WhatsApp
-- ============================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_envio_guard_logs (
  id bigserial PRIMARY KEY,
  company_id integer REFERENCES public.empresas(id) ON DELETE SET NULL,
  conversa_id integer REFERENCES public.conversas(id) ON DELETE SET NULL,
  endpoint varchar(80) NOT NULL,
  tipo varchar(50),
  origem varchar(120) DEFAULT 'nao_informado',
  origem_tipo varchar(30) DEFAULT 'unknown',
  risco varchar(20) DEFAULT 'medium',
  modo varchar(20) DEFAULT 'monitor',
  acao varchar(30) DEFAULT 'allow',
  motivos jsonb DEFAULT '[]'::jsonb,
  delay_ms integer DEFAULT 0,
  destino_tail varchar(30),
  destino_hash varchar(64),
  texto_tamanho integer,
  arquivo_tamanho integer,
  status_http integer,
  sucesso boolean,
  message_id varchar(220),
  erro text,
  duracao_ms integer,
  criado_em timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_envio_guard_company_criado
  ON public.whatsapp_envio_guard_logs(company_id, criado_em DESC);

-- ============================================================
-- 5) Financeiro / pagamentos
-- ============================================================
ALTER TABLE public.conversas DROP CONSTRAINT IF EXISTS conversas_status_atendimento_check;

ALTER TABLE public.conversas ADD CONSTRAINT conversas_status_atendimento_check
  CHECK (status_atendimento = ANY (ARRAY[
    'aberta'::text,
    'em_atendimento'::text,
    'aguardando_cliente'::text,
    'pagamento_pendente'::text,
    'em_atraso'::text,
    'fechada'::text,
    'finalizada'::text,
    'mensagem_disparada'::text
  ]));

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS pagamento_prazo_ate timestamptz,
  ADD COLUMN IF NOT EXISTS pagamento_prazo_origem text,
  ADD COLUMN IF NOT EXISTS pagamento_concluido_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_prazo_vencido
  ON public.conversas (company_id, pagamento_prazo_ate)
  WHERE status_atendimento = 'pagamento_pendente'::text;

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_pendente_lista
  ON public.conversas (company_id, status_atendimento, atendente_id)
  WHERE status_atendimento IN ('pagamento_pendente'::text, 'em_atraso'::text);

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_concluido_lista
  ON public.conversas (company_id, atendente_id)
  WHERE pagamento_concluido_em IS NOT NULL
    AND status_atendimento = 'em_atendimento'::text;

-- ============================================================
-- 6) Idempotencia mensagens WhatsApp (unique parcial)
-- ============================================================
DROP INDEX IF EXISTS public.idx_mensagens_company_whatsapp_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_company_whatsapp_id
  ON public.mensagens (company_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL AND whatsapp_id != '';

-- ============================================================
-- 7) Impedir duas empresas ATIVAS com mesmo instance_id
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_empresa_zapi_instance_id_ativo
  ON public.empresa_zapi (instance_id)
  WHERE ativo = true
    AND instance_id IS NOT NULL
    AND btrim(instance_id) <> '';
