-- =============================================================================
-- Company 1 — APAGAR conversas Contato/LID + mensagens + clientes
-- =============================================================================
-- Cole e rode APENAS o bloco DO abaixo (inteiro, de DO até END $$).
-- Depois: Ctrl+Shift+R no chat.
-- =============================================================================

DO $$
DECLARE
  v_company_id   int := 1;
  v_conversa_ids int[];
  v_cliente_ids  int[];
  v_n            int;
BEGIN
  SELECT coalesce(array_agg(DISTINCT c.id), ARRAY[]::int[])
  INTO v_conversa_ids
  FROM public.conversas c
  LEFT JOIN public.clientes cl
    ON cl.id = c.cliente_id AND cl.company_id = c.company_id
  WHERE c.company_id = v_company_id
    AND lower(coalesce(c.tipo, '')) <> 'grupo'
    AND coalesce(c.telefone, '') NOT LIKE '%@g.us'
    AND (
      lower(trim(coalesce(c.nome_contato_cache, ''))) IN ('contato', '(contato)')
      OR lower(trim(coalesce(cl.nome, ''))) IN ('contato', '(contato)')
      OR lower(coalesce(c.telefone, '')) LIKE 'lid:%'
      OR lower(coalesce(c.telefone, '')) LIKE '%@lid'
      OR (
        coalesce(nullif(trim(cl.nome), ''), '') = ''
        AND coalesce(nullif(trim(cl.pushname), ''), '') = ''
        AND coalesce(nullif(trim(c.nome_contato_cache), ''), '') = ''
        AND (
          c.telefone IS NULL OR trim(c.telefone) = ''
          OR lower(c.telefone) LIKE 'lid:%'
          OR lower(c.telefone) LIKE '%@lid'
        )
      )
    );

  SELECT coalesce(array_agg(DISTINCT x.cid), ARRAY[]::int[])
  INTO v_cliente_ids
  FROM (
    SELECT c.cliente_id AS cid
    FROM public.conversas c
    WHERE c.company_id = v_company_id
      AND c.id = ANY(v_conversa_ids)
      AND c.cliente_id IS NOT NULL
    UNION
    SELECT cl.id
    FROM public.clientes cl
    WHERE cl.company_id = v_company_id
      AND (
        lower(trim(coalesce(cl.nome, ''))) IN ('contato', '(contato)')
        OR lower(coalesce(cl.telefone, '')) LIKE 'lid:%'
        OR lower(coalesce(cl.telefone, '')) LIKE '%@lid'
      )
  ) x
  WHERE x.cid IS NOT NULL;

  RAISE NOTICE 'Conversas: % | Clientes: %',
    coalesce(array_length(v_conversa_ids, 1), 0),
    coalesce(array_length(v_cliente_ids, 1), 0);

  IF coalesce(array_length(v_conversa_ids, 1), 0) = 0 THEN
    RAISE NOTICE 'Nenhuma conversa Contato/LID encontrada.';
  ELSE
    DELETE FROM public.avaliacoes_atendimento
    WHERE company_id = v_company_id
      AND (
        conversa_id = ANY(v_conversa_ids)
        OR atendimento_id IN (
          SELECT id FROM public.atendimentos
          WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids)
        )
      );

    DELETE FROM public.bot_logs
    WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids);

    DELETE FROM public.historico_atendimentos
    WHERE conversa_id = ANY(v_conversa_ids);

    IF to_regclass('public.mensagens_ocultas') IS NOT NULL THEN
      DELETE FROM public.mensagens_ocultas
      WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids);
    END IF;

    IF to_regclass('public.conversa_unreads') IS NOT NULL THEN
      DELETE FROM public.conversa_unreads
      WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids);
    END IF;

    IF to_regclass('public.conversa_tags') IS NOT NULL THEN
      DELETE FROM public.conversa_tags
      WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids);
    END IF;

    IF to_regclass('public.conversa_atendentes') IS NOT NULL THEN
      DELETE FROM public.conversa_atendentes
      WHERE conversa_id = ANY(v_conversa_ids);
    END IF;

    IF to_regclass('public.conversa_usuario_prefs') IS NOT NULL THEN
      DELETE FROM public.conversa_usuario_prefs
      WHERE conversa_id = ANY(v_conversa_ids);
    END IF;

    IF to_regclass('public.crm_leads') IS NOT NULL THEN
      UPDATE public.crm_leads
      SET conversa_id = NULL
      WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids);
    END IF;

    IF to_regclass('public.whatsapp_send_guard_logs') IS NOT NULL THEN
      UPDATE public.whatsapp_send_guard_logs
      SET conversa_id = NULL
      WHERE conversa_id = ANY(v_conversa_ids);
    END IF;

    IF to_regclass('public.departamento_grupos_whatsapp') IS NOT NULL THEN
      DELETE FROM public.departamento_grupos_whatsapp
      WHERE conversa_id = ANY(v_conversa_ids);
    END IF;

    DELETE FROM public.atendimentos
    WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids);

    DELETE FROM public.mensagens
    WHERE company_id = v_company_id AND conversa_id = ANY(v_conversa_ids);

    UPDATE public.conversas
    SET cliente_id = NULL
    WHERE company_id = v_company_id AND id = ANY(v_conversa_ids);

    DELETE FROM public.conversas
    WHERE company_id = v_company_id AND id = ANY(v_conversa_ids);

    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Conversas apagadas: %', v_n;
  END IF;

  IF coalesce(array_length(v_cliente_ids, 1), 0) > 0 THEN
    UPDATE public.conversas
    SET cliente_id = NULL
    WHERE company_id = v_company_id AND cliente_id = ANY(v_cliente_ids);

    IF to_regclass('public.contato_opt_out') IS NOT NULL THEN
      DELETE FROM public.contato_opt_out WHERE cliente_id = ANY(v_cliente_ids);
    END IF;
    IF to_regclass('public.contato_opt_in') IS NOT NULL THEN
      DELETE FROM public.contato_opt_in WHERE cliente_id = ANY(v_cliente_ids);
    END IF;
    IF to_regclass('public.campanha_envios') IS NOT NULL THEN
      DELETE FROM public.campanha_envios WHERE cliente_id = ANY(v_cliente_ids);
    END IF;
    IF to_regclass('public.cliente_tags') IS NOT NULL THEN
      DELETE FROM public.cliente_tags WHERE cliente_id = ANY(v_cliente_ids);
    END IF;
    IF to_regclass('public.crm_leads') IS NOT NULL THEN
      UPDATE public.crm_leads
      SET cliente_id = NULL
      WHERE company_id = v_company_id AND cliente_id = ANY(v_cliente_ids);
    END IF;

    DELETE FROM public.avaliacoes_atendimento
    WHERE company_id = v_company_id AND cliente_id = ANY(v_cliente_ids);

    DELETE FROM public.clientes
    WHERE company_id = v_company_id AND id = ANY(v_cliente_ids);

    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Clientes apagados: %', v_n;
  END IF;

  SELECT count(*)::int INTO v_n
  FROM public.conversas c
  LEFT JOIN public.clientes cl
    ON cl.id = c.cliente_id AND cl.company_id = c.company_id
  WHERE c.company_id = v_company_id
    AND lower(coalesce(c.tipo, '')) <> 'grupo'
    AND (
      lower(trim(coalesce(c.nome_contato_cache, ''))) IN ('contato', '(contato)')
      OR lower(trim(coalesce(cl.nome, ''))) IN ('contato', '(contato)')
      OR lower(coalesce(c.telefone, '')) LIKE 'lid:%'
      OR lower(coalesce(c.telefone, '')) LIKE '%@lid'
    );

  RAISE NOTICE 'Restantes Contato/LID na company 1: %', v_n;
END $$;
