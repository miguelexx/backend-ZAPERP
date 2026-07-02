-- Persistent WhatsApp outbound queue backed by public.mensagens.
-- The controller creates a local message first; this metadata lets a worker
-- claim, retry and audit the real provider send without losing work on restart.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS client_temp_id text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS send_payload jsonb,
  ADD COLUMN IF NOT EXISTS send_status text DEFAULT 'not_queued',
  ADD COLUMN IF NOT EXISTS tentativas_envio integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_tentativas_envio integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS enviando_ate timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS ultimo_erro_envio text,
  ADD COLUMN IF NOT EXISTS ultimo_codigo_erro text,
  ADD COLUMN IF NOT EXISTS queued_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_client_temp_idempotency
  ON public.mensagens (company_id, conversa_id, autor_usuario_id, client_temp_id)
  WHERE client_temp_id IS NOT NULL AND client_temp_id <> '';

CREATE INDEX IF NOT EXISTS idx_mensagens_outbound_queue_due
  ON public.mensagens (next_attempt_at, id)
  WHERE direcao = 'out'
    AND send_payload IS NOT NULL
    AND whatsapp_id IS NULL
    AND COALESCE(send_status, '') IN ('queued', 'retry', 'sending');

CREATE INDEX IF NOT EXISTS idx_mensagens_outbound_queue_instance_due
  ON public.mensagens (whatsapp_instance_id, next_attempt_at, id)
  WHERE direcao = 'out'
    AND send_payload IS NOT NULL
    AND whatsapp_id IS NULL
    AND COALESCE(send_status, '') IN ('queued', 'retry', 'sending');

CREATE INDEX IF NOT EXISTS idx_mensagens_outbound_queue_company_status
  ON public.mensagens (company_id, send_status, criado_em DESC)
  WHERE direcao = 'out' AND send_payload IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.whatsapp_outbound_jobs (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id),
  conversa_id integer NULL REFERENCES public.conversas(id),
  autor_usuario_id bigint NULL,
  whatsapp_instance_id integer NULL,
  destination_phone text NOT NULL,
  kind text NOT NULL DEFAULT 'text',
  send_payload jsonb NOT NULL,
  send_status text NOT NULL DEFAULT 'queued',
  tentativas_envio integer NOT NULL DEFAULT 0,
  max_tentativas_envio integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  locked_at timestamptz,
  enviando_ate timestamptz,
  locked_by text,
  ultimo_erro_envio text,
  ultimo_codigo_erro text,
  provider_message_id text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_jobs_due
  ON public.whatsapp_outbound_jobs (next_attempt_at, id)
  WHERE COALESCE(send_status, '') IN ('queued', 'retry', 'sending');

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_jobs_instance_due
  ON public.whatsapp_outbound_jobs (company_id, whatsapp_instance_id, next_attempt_at, id)
  WHERE COALESCE(send_status, '') IN ('queued', 'retry', 'sending');

CREATE OR REPLACE FUNCTION public.claim_whatsapp_outbound_messages(
  p_worker_id text,
  p_limit integer DEFAULT 10,
  p_lock_seconds integer DEFAULT 120,
  p_max_per_queue integer DEFAULT 1,
  p_send_delay_ms integer DEFAULT 0
)
RETURNS SETOF public.mensagens
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH eligible AS (
    SELECT
      m.id,
      m.company_id::text || ':' || COALESCE(m.whatsapp_instance_id::text, 'company') AS queue_key,
      COALESCE(m.next_attempt_at, m.criado_em::timestamptz, now()) AS due_at
    FROM public.mensagens m
    WHERE m.direcao = 'out'
      AND m.send_payload IS NOT NULL
      AND m.whatsapp_id IS NULL
      AND COALESCE(m.send_status, 'queued') IN ('queued', 'retry', 'sending')
      AND COALESCE(m.tentativas_envio, 0) < COALESCE(m.max_tentativas_envio, 5)
      AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= now())
      AND (m.enviando_ate IS NULL OR m.enviando_ate < now())
      AND (
        SELECT COUNT(*)
        FROM (
          SELECT 1
          FROM public.mensagens mx
          WHERE mx.direcao = 'out'
            AND mx.send_payload IS NOT NULL
            AND mx.whatsapp_id IS NULL
            AND mx.send_status = 'sending'
            AND mx.enviando_ate > now()
            AND (mx.company_id::text || ':' || COALESCE(mx.whatsapp_instance_id::text, 'company')) =
                (m.company_id::text || ':' || COALESCE(m.whatsapp_instance_id::text, 'company'))
          UNION ALL
          SELECT 1
          FROM public.whatsapp_outbound_jobs jx
          WHERE jx.send_status = 'sending'
            AND jx.enviando_ate > now()
            AND COALESCE(jx.provider_message_id, '') = ''
            AND (jx.company_id::text || ':' || COALESCE(jx.whatsapp_instance_id::text, 'company')) =
                (m.company_id::text || ':' || COALESCE(m.whatsapp_instance_id::text, 'company'))
        ) active_sends
      ) < GREATEST(1, COALESCE(p_max_per_queue, 1))
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            md.company_id::text || ':' || COALESCE(md.whatsapp_instance_id::text, 'company') AS qk,
            GREATEST(COALESCE(md.locked_at, '-infinity'::timestamptz), COALESCE(md.sent_at, '-infinity'::timestamptz)) AS event_at
          FROM public.mensagens md
          WHERE md.direcao = 'out'
            AND md.send_payload IS NOT NULL
          UNION ALL
          SELECT
            jd.company_id::text || ':' || COALESCE(jd.whatsapp_instance_id::text, 'company') AS qk,
            GREATEST(COALESCE(jd.locked_at, '-infinity'::timestamptz), COALESCE(jd.sent_at, '-infinity'::timestamptz)) AS event_at
          FROM public.whatsapp_outbound_jobs jd
        ) recent
        WHERE recent.qk = (m.company_id::text || ':' || COALESCE(m.whatsapp_instance_id::text, 'company'))
          AND recent.event_at > now() - make_interval(secs => GREATEST(0, COALESCE(p_send_delay_ms, 0)) / 1000.0)
      )
  ),
  picked AS (
    SELECT DISTINCT ON (queue_key)
      id,
      queue_key,
      due_at
    FROM eligible
    ORDER BY queue_key, due_at, id
  ),
  locked AS (
    SELECT m.id
    FROM public.mensagens m
    JOIN picked p ON p.id = m.id
    WHERE pg_try_advisory_xact_lock(hashtext('wa_outbound_instance:' || p.queue_key))
    ORDER BY p.due_at, m.id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 100))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.mensagens m
  SET
    send_status = 'sending',
    status = 'pending',
    status_mensagem = 'sending',
    locked_at = now(),
    enviando_ate = now() + make_interval(secs => GREATEST(30, COALESCE(p_lock_seconds, 120))),
    locked_by = COALESCE(NULLIF(p_worker_id, ''), 'worker'),
    tentativas_envio = COALESCE(m.tentativas_envio, 0) + 1
  FROM locked
  WHERE m.id = locked.id
  RETURNING m.*;
$$;

COMMENT ON FUNCTION public.claim_whatsapp_outbound_messages(text, integer, integer, integer, integer)
  IS 'Atomically claims due outbound WhatsApp messages, one per instance/company queue key, with a time-bounded lock.';

CREATE OR REPLACE FUNCTION public.claim_whatsapp_outbound_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 10,
  p_lock_seconds integer DEFAULT 120,
  p_max_per_queue integer DEFAULT 1,
  p_send_delay_ms integer DEFAULT 0
)
RETURNS SETOF public.whatsapp_outbound_jobs
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH eligible AS (
    SELECT
      j.id,
      j.company_id::text || ':' || COALESCE(j.whatsapp_instance_id::text, 'company') AS queue_key,
      COALESCE(j.next_attempt_at, j.criado_em, now()) AS due_at
    FROM public.whatsapp_outbound_jobs j
    WHERE j.send_payload IS NOT NULL
      AND COALESCE(j.provider_message_id, '') = ''
      AND COALESCE(j.send_status, 'queued') IN ('queued', 'retry', 'sending')
      AND COALESCE(j.tentativas_envio, 0) < COALESCE(j.max_tentativas_envio, 5)
      AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
      AND (j.enviando_ate IS NULL OR j.enviando_ate < now())
      AND (
        SELECT COUNT(*)
        FROM (
          SELECT 1
          FROM public.mensagens mx
          WHERE mx.direcao = 'out'
            AND mx.send_payload IS NOT NULL
            AND mx.whatsapp_id IS NULL
            AND mx.send_status = 'sending'
            AND mx.enviando_ate > now()
            AND (mx.company_id::text || ':' || COALESCE(mx.whatsapp_instance_id::text, 'company')) =
                (j.company_id::text || ':' || COALESCE(j.whatsapp_instance_id::text, 'company'))
          UNION ALL
          SELECT 1
          FROM public.whatsapp_outbound_jobs jx
          WHERE jx.send_status = 'sending'
            AND jx.enviando_ate > now()
            AND COALESCE(jx.provider_message_id, '') = ''
            AND (jx.company_id::text || ':' || COALESCE(jx.whatsapp_instance_id::text, 'company')) =
                (j.company_id::text || ':' || COALESCE(j.whatsapp_instance_id::text, 'company'))
        ) active_sends
      ) < GREATEST(1, COALESCE(p_max_per_queue, 1))
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            md.company_id::text || ':' || COALESCE(md.whatsapp_instance_id::text, 'company') AS qk,
            GREATEST(COALESCE(md.locked_at, '-infinity'::timestamptz), COALESCE(md.sent_at, '-infinity'::timestamptz)) AS event_at
          FROM public.mensagens md
          WHERE md.direcao = 'out'
            AND md.send_payload IS NOT NULL
          UNION ALL
          SELECT
            jd.company_id::text || ':' || COALESCE(jd.whatsapp_instance_id::text, 'company') AS qk,
            GREATEST(COALESCE(jd.locked_at, '-infinity'::timestamptz), COALESCE(jd.sent_at, '-infinity'::timestamptz)) AS event_at
          FROM public.whatsapp_outbound_jobs jd
        ) recent
        WHERE recent.qk = (j.company_id::text || ':' || COALESCE(j.whatsapp_instance_id::text, 'company'))
          AND recent.event_at > now() - make_interval(secs => GREATEST(0, COALESCE(p_send_delay_ms, 0)) / 1000.0)
      )
  ),
  picked AS (
    SELECT DISTINCT ON (queue_key)
      id,
      queue_key,
      due_at
    FROM eligible
    ORDER BY queue_key, due_at, id
  ),
  locked AS (
    SELECT j.id
    FROM public.whatsapp_outbound_jobs j
    JOIN picked p ON p.id = j.id
    WHERE pg_try_advisory_xact_lock(hashtext('wa_outbound_instance:' || p.queue_key))
    ORDER BY p.due_at, j.id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 100))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_outbound_jobs j
  SET
    send_status = 'sending',
    locked_at = now(),
    enviando_ate = now() + make_interval(secs => GREATEST(30, COALESCE(p_lock_seconds, 120))),
    locked_by = COALESCE(NULLIF(p_worker_id, ''), 'worker'),
    tentativas_envio = COALESCE(j.tentativas_envio, 0) + 1,
    atualizado_em = now()
  FROM locked
  WHERE j.id = locked.id
  RETURNING j.*;
$$;
