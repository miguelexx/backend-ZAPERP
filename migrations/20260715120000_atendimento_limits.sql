-- ============================================================
-- Limites de Atendimento
-- Modulo opcional: nenhuma empresa e ativada automaticamente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.atendimento_limits_company_configs (
  company_id integer PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  default_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  atualizado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.atendimento_limits_user_configs (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  use_company_default boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT atendimento_limits_user_configs_unique UNIQUE (company_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS public.atendimento_limits_consumptions (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  conversa_id integer NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('message', 'new_conversation')),
  message_type text,
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_atendimento_limits_consumptions_idempotency
  ON public.atendimento_limits_consumptions(company_id, usuario_id, kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_atendimento_limits_consumptions_user_time
  ON public.atendimento_limits_consumptions(company_id, usuario_id, kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_atendimento_limits_consumptions_conversa_time
  ON public.atendimento_limits_consumptions(company_id, conversa_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.atendimento_limits_history (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  admin_usuario_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('company_default', 'user')),
  target_usuario_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  previous_value jsonb,
  new_value jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atendimento_limits_history_company_time
  ON public.atendimento_limits_history(company_id, criado_em DESC);

COMMENT ON TABLE public.atendimento_limits_company_configs IS 'Configuracao opcional dos limites de atendimento por empresa. enabled=false por padrao.';
COMMENT ON TABLE public.atendimento_limits_user_configs IS 'Sobrescrita opcional de limites por usuario, isolada por empresa.';
COMMENT ON TABLE public.atendimento_limits_consumptions IS 'Consumo persistente/idempotente dos limites de atendimento.';
COMMENT ON TABLE public.atendimento_limits_history IS 'Historico basico das alteracoes dos limites de atendimento.';

CREATE OR REPLACE FUNCTION public.atendimento_limits_validate_and_consume(
  p_company_id integer,
  p_usuario_id integer,
  p_conversa_id integer,
  p_idempotency_key text DEFAULT NULL,
  p_message_type text DEFAULT 'texto',
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_company public.atendimento_limits_company_configs%ROWTYPE;
  v_user public.atendimento_limits_user_configs%ROWTYPE;
  v_cfg jsonb;
  v_tz text;
  v_is_new_conversation boolean := false;
  v_used integer := 0;
  v_limit integer := 0;
  v_last_at timestamptz;
  v_retry_after integer := 0;
  v_local_now timestamp;
  v_local_time time;
  v_dow integer;
  v_allowed_days jsonb;
  v_allowed_start time;
  v_allowed_end time;
  v_should_check_hours boolean := false;
  v_last_inbound_at timestamptz;
BEGIN
  IF p_company_id IS NULL OR p_usuario_id IS NULL OR p_conversa_id IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'consumed', false, 'skipped', 'invalid_context');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('atendimento_limits:' || p_company_id || ':' || p_usuario_id, 0));

  SELECT *
    INTO v_company
    FROM public.atendimento_limits_company_configs
   WHERE company_id = p_company_id;

  IF NOT FOUND OR v_company.enabled IS NOT TRUE THEN
    RETURN jsonb_build_object('allowed', true, 'consumed', false, 'module_enabled', false);
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.atendimento_limits_consumptions
     WHERE company_id = p_company_id
       AND usuario_id = p_usuario_id
       AND kind = 'message'
       AND idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('allowed', true, 'consumed', false, 'deduplicated', true);
  END IF;

  SELECT *
    INTO v_user
    FROM public.atendimento_limits_user_configs
   WHERE company_id = p_company_id
     AND usuario_id = p_usuario_id;

  v_cfg := COALESCE(v_company.default_config, '{}'::jsonb);
  IF FOUND AND v_user.use_company_default IS FALSE THEN
    v_cfg := v_cfg || COALESCE(v_user.config, '{}'::jsonb);
  END IF;

  v_tz := COALESCE(NULLIF(v_cfg->>'timezone', ''), NULLIF(v_company.timezone, ''), 'America/Sao_Paulo');

  SELECT NOT EXISTS (
    SELECT 1
      FROM public.mensagens
     WHERE company_id = p_company_id
       AND conversa_id = p_conversa_id
       AND direcao = 'out'
     LIMIT 1
  ) INTO v_is_new_conversation;

  v_should_check_hours :=
    COALESCE((v_cfg->>'allowed_hours_enabled')::boolean, false)
    AND (
      v_is_new_conversation
      OR COALESCE((v_cfg->>'allow_existing_replies_outside_hours')::boolean, true) IS FALSE
      OR COALESCE((v_cfg->>'block_new_conversations_only')::boolean, true) IS FALSE
    );

  IF v_should_check_hours THEN
    v_local_now := p_now AT TIME ZONE v_tz;
    v_local_time := v_local_now::time;
    v_dow := EXTRACT(DOW FROM v_local_now)::integer;
    v_allowed_days := COALESCE(v_cfg->'allowed_days', '[1,2,3,4,5]'::jsonb);
    v_allowed_start := COALESCE(NULLIF(v_cfg->>'allowed_start', '')::time, '08:00'::time);
    v_allowed_end := COALESCE(NULLIF(v_cfg->>'allowed_end', '')::time, '18:00'::time);

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(v_allowed_days) AS allowed_day(value)
       WHERE allowed_day.value ~ '^\d+$'
         AND allowed_day.value::integer = v_dow
    ) OR NOT (
      CASE
        WHEN v_allowed_start <= v_allowed_end THEN v_local_time >= v_allowed_start AND v_local_time <= v_allowed_end
        ELSE v_local_time >= v_allowed_start OR v_local_time <= v_allowed_end
      END
    ) THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'code', 'OUTSIDE_ALLOWED_HOURS',
        'message', 'Novas conversas podem ser iniciadas entre ' || to_char(v_allowed_start, 'HH24:MI') || ' e ' || to_char(v_allowed_end, 'HH24:MI') || '.',
        'used', null,
        'limit', null,
        'release_at', null,
        'is_new_conversation', v_is_new_conversation
      );
    END IF;
  END IF;

  IF COALESCE((v_cfg->>'message_interval_seconds_enabled')::boolean, false) THEN
    v_limit := NULLIF(v_cfg->>'message_interval_seconds', '')::integer;
    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      SELECT max(occurred_at)
        INTO v_last_at
        FROM public.atendimento_limits_consumptions
       WHERE company_id = p_company_id
         AND usuario_id = p_usuario_id
         AND kind = 'message';
      IF v_last_at IS NOT NULL AND p_now < v_last_at + make_interval(secs => v_limit) THEN
        v_retry_after := CEIL(EXTRACT(EPOCH FROM ((v_last_at + make_interval(secs => v_limit)) - p_now)))::integer;
        RETURN jsonb_build_object(
          'allowed', false,
          'code', 'MESSAGE_INTERVAL_ACTIVE',
          'message', 'Aguarde ' || GREATEST(v_retry_after, 1) || ' segundos para enviar outra mensagem.',
          'used', null,
          'limit', v_limit,
          'retry_after_seconds', GREATEST(v_retry_after, 1),
          'release_at', v_last_at + make_interval(secs => v_limit),
          'is_new_conversation', v_is_new_conversation
        );
      END IF;
    END IF;
  END IF;

  IF v_is_new_conversation AND COALESCE((v_cfg->>'new_conversation_interval_seconds_enabled')::boolean, false) THEN
    v_limit := NULLIF(v_cfg->>'new_conversation_interval_seconds', '')::integer;
    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      SELECT max(occurred_at)
        INTO v_last_at
        FROM public.atendimento_limits_consumptions
       WHERE company_id = p_company_id
         AND usuario_id = p_usuario_id
         AND kind = 'new_conversation';
      IF v_last_at IS NOT NULL AND p_now < v_last_at + make_interval(secs => v_limit) THEN
        v_retry_after := CEIL(EXTRACT(EPOCH FROM ((v_last_at + make_interval(secs => v_limit)) - p_now)))::integer;
        RETURN jsonb_build_object(
          'allowed', false,
          'code', 'NEW_CONVERSATION_INTERVAL_ACTIVE',
          'message', 'Aguarde ' || GREATEST(v_retry_after, 1) || ' segundos para iniciar outra conversa.',
          'used', null,
          'limit', v_limit,
          'retry_after_seconds', GREATEST(v_retry_after, 1),
          'release_at', v_last_at + make_interval(secs => v_limit),
          'is_new_conversation', true
        );
      END IF;
    END IF;
  END IF;

  IF COALESCE((v_cfg->>'messages_per_hour_enabled')::boolean, false) THEN
    v_limit := NULLIF(v_cfg->>'messages_per_hour', '')::integer;
    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      SELECT count(*) INTO v_used
        FROM public.atendimento_limits_consumptions
       WHERE company_id = p_company_id
         AND usuario_id = p_usuario_id
         AND kind = 'message'
         AND occurred_at >= date_trunc('hour', p_now);
      IF v_used >= v_limit THEN
        RETURN jsonb_build_object('allowed', false, 'code', 'LIMIT_MESSAGES_PER_HOUR', 'message', 'Voce atingiu o limite de ' || v_limit || ' mensagens por hora.', 'used', v_used, 'limit', v_limit, 'reset_at', date_trunc('hour', p_now) + interval '1 hour', 'is_new_conversation', v_is_new_conversation);
      END IF;
    END IF;
  END IF;

  IF COALESCE((v_cfg->>'messages_per_day_enabled')::boolean, false) THEN
    v_limit := NULLIF(v_cfg->>'messages_per_day', '')::integer;
    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      SELECT count(*) INTO v_used
        FROM public.atendimento_limits_consumptions
       WHERE company_id = p_company_id
         AND usuario_id = p_usuario_id
         AND kind = 'message'
         AND (occurred_at AT TIME ZONE v_tz)::date = (p_now AT TIME ZONE v_tz)::date;
      IF v_used >= v_limit THEN
        RETURN jsonb_build_object('allowed', false, 'code', 'LIMIT_MESSAGES_PER_DAY', 'message', 'Voce atingiu o limite de ' || v_limit || ' mensagens por dia.', 'used', v_used, 'limit', v_limit, 'reset_at', (((p_now AT TIME ZONE v_tz)::date + 1)::timestamp AT TIME ZONE v_tz), 'is_new_conversation', v_is_new_conversation);
      END IF;
    END IF;
  END IF;

  IF v_is_new_conversation AND COALESCE((v_cfg->>'new_conversations_per_hour_enabled')::boolean, false) THEN
    v_limit := NULLIF(v_cfg->>'new_conversations_per_hour', '')::integer;
    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      SELECT count(*) INTO v_used
        FROM public.atendimento_limits_consumptions
       WHERE company_id = p_company_id
         AND usuario_id = p_usuario_id
         AND kind = 'new_conversation'
         AND occurred_at >= date_trunc('hour', p_now);
      IF v_used >= v_limit THEN
        RETURN jsonb_build_object('allowed', false, 'code', 'LIMIT_NEW_CONVERSATIONS_PER_HOUR', 'message', 'Voce atingiu o limite de ' || v_limit || ' novas conversas por hora.', 'used', v_used, 'limit', v_limit, 'reset_at', date_trunc('hour', p_now) + interval '1 hour', 'is_new_conversation', true);
      END IF;
    END IF;
  END IF;

  IF v_is_new_conversation AND COALESCE((v_cfg->>'new_conversations_per_day_enabled')::boolean, false) THEN
    v_limit := NULLIF(v_cfg->>'new_conversations_per_day', '')::integer;
    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      SELECT count(*) INTO v_used
        FROM public.atendimento_limits_consumptions
       WHERE company_id = p_company_id
         AND usuario_id = p_usuario_id
         AND kind = 'new_conversation'
         AND (occurred_at AT TIME ZONE v_tz)::date = (p_now AT TIME ZONE v_tz)::date;
      IF v_used >= v_limit THEN
        RETURN jsonb_build_object('allowed', false, 'code', 'LIMIT_NEW_CONVERSATIONS_PER_DAY', 'message', 'Voce atingiu o limite de ' || v_limit || ' novas conversas por dia.', 'used', v_used, 'limit', v_limit, 'reset_at', (((p_now AT TIME ZONE v_tz)::date + 1)::timestamp AT TIME ZONE v_tz), 'is_new_conversation', true);
      END IF;
    END IF;
  END IF;

  IF COALESCE((v_cfg->>'consecutive_without_reply_enabled')::boolean, false) THEN
    v_limit := NULLIF(v_cfg->>'consecutive_without_reply', '')::integer;
    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      SELECT max(criado_em)
        INTO v_last_inbound_at
        FROM public.mensagens
       WHERE company_id = p_company_id
         AND conversa_id = p_conversa_id
         AND direcao = 'in';

      SELECT count(*)
        INTO v_used
        FROM public.mensagens
       WHERE company_id = p_company_id
         AND conversa_id = p_conversa_id
         AND direcao = 'out'
         AND (v_last_inbound_at IS NULL OR criado_em > v_last_inbound_at);

      IF v_used >= v_limit THEN
        RETURN jsonb_build_object(
          'allowed', false,
          'code', 'CONSECUTIVE_MESSAGES_LIMIT',
          'message', 'O cliente precisa responder antes de voce enviar outra mensagem.',
          'used', v_used,
          'limit', v_limit,
          'reset_at', null,
          'is_new_conversation', v_is_new_conversation
        );
      END IF;
    END IF;
  END IF;

  INSERT INTO public.atendimento_limits_consumptions(company_id, usuario_id, conversa_id, kind, message_type, idempotency_key, occurred_at)
  VALUES (p_company_id, p_usuario_id, p_conversa_id, 'message', p_message_type, p_idempotency_key, p_now)
  ON CONFLICT DO NOTHING;

  IF v_is_new_conversation THEN
    INSERT INTO public.atendimento_limits_consumptions(company_id, usuario_id, conversa_id, kind, message_type, idempotency_key, occurred_at)
    VALUES (p_company_id, p_usuario_id, p_conversa_id, 'new_conversation', p_message_type, p_idempotency_key, p_now)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('allowed', true, 'consumed', true, 'is_new_conversation', v_is_new_conversation);
END;
$$;
