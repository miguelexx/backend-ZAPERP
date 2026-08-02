BEGIN;

-- Auditoria durável e idempotência do envio de TEXTO MANUAL do atendimento.
-- As colunas são opcionais para todos os demais fluxos e só são preenchidas
-- pelo endpoint POST /chats/:id/mensagens quando não há payload de link/mídia.
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS provider_reference_id text,
  ADD COLUMN IF NOT EXISTS provider_request jsonb,
  ADD COLUMN IF NOT EXISTS provider_delivery_state text,
  ADD COLUMN IF NOT EXISTS provider_http_status integer,
  ADD COLUMN IF NOT EXISTS provider_response jsonb,
  ADD COLUMN IF NOT EXISTS provider_error text,
  ADD COLUMN IF NOT EXISTS provider_retryable boolean,
  ADD COLUMN IF NOT EXISTS provider_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_last_attempt_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_company_provider_reference_unique
  ON public.mensagens (company_id, provider_reference_id)
  WHERE provider_reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mensagens_manual_text_provider_lookup
  ON public.mensagens (company_id, conversa_id, provider_last_attempt_at DESC)
  WHERE direcao = 'out'
    AND tipo = 'texto'
    AND provider_reference_id IS NOT NULL;

COMMENT ON COLUMN public.mensagens.provider_reference_id IS
  'referenceId estável enviado ao provedor; no texto manual usa crm-{mensagens.id}.';
COMMENT ON COLUMN public.mensagens.provider_request IS
  'Payload não secreto necessário para auditar/repetir com segurança o texto manual.';
COMMENT ON COLUMN public.mensagens.provider_delivery_state IS
  'Resultado normalizado do provedor: dispatching, accepted, queued, accepted_untracked, rejected ou uncertain.';
COMMENT ON COLUMN public.mensagens.provider_response IS
  'Resposta sanitizada do provedor para auditoria do envio manual.';
COMMENT ON COLUMN public.mensagens.provider_error IS
  'Erro detalhado e sanitizado do provedor no envio manual.';

COMMIT;
