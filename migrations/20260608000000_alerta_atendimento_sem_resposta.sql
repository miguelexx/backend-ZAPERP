-- Alertas de atendimento sem resposta (config em ia_config.config.alerta_sem_resposta)

CREATE TABLE IF NOT EXISTS public.alerta_atendimento_sem_resposta_eventos (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  conversa_id BIGINT NOT NULL,
  atendente_id BIGINT,
  tipo TEXT NOT NULL,
  nivel TEXT,
  mensagem TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerta_sem_resposta_eventos_company_criado
  ON public.alerta_atendimento_sem_resposta_eventos (company_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_alerta_sem_resposta_eventos_conversa
  ON public.alerta_atendimento_sem_resposta_eventos (company_id, conversa_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS public.alerta_atendimento_sem_resposta_estado (
  company_id BIGINT NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  conversa_id BIGINT NOT NULL,
  ultimo_cliente_msg_em TIMESTAMPTZ,
  primeiro_alerta_em TIMESTAMPTZ,
  alerta_critico_em TIMESTAMPTZ,
  gestor_notificado_em TIMESTAMPTZ,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, conversa_id)
);

CREATE INDEX IF NOT EXISTS idx_alerta_sem_resposta_estado_company
  ON public.alerta_atendimento_sem_resposta_estado (company_id);

COMMENT ON TABLE public.alerta_atendimento_sem_resposta_eventos IS
  'Log de alertas de atendimento sem resposta (escalonamento por conversa).';
COMMENT ON TABLE public.alerta_atendimento_sem_resposta_estado IS
  'Estado/idempotência do escalonamento por conversa (evita reenvio do mesmo nível).';

-- Permissões Supabase (backend usa service_role; tabelas novas precisam de GRANT explícito)
GRANT ALL ON TABLE public.alerta_atendimento_sem_resposta_eventos TO postgres, service_role;
GRANT ALL ON TABLE public.alerta_atendimento_sem_resposta_estado TO postgres, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.alerta_atendimento_sem_resposta_eventos_id_seq TO postgres, service_role;
