-- =============================================================================
-- Company 1: fechar Contato + já finalizadas (ainda Aberta)
-- =============================================================================
-- Rode SEPARADO: primeiro a prévia, depois o DO.
-- Não rode o arquivo inteiro de uma vez se o client misturar blocos.
-- =============================================================================

-- ============================================================
-- PRÉVIA (rode só isto primeiro)
-- ============================================================
SELECT
  c.id,
  c.telefone,
  c.status_atendimento,
  c.nome_contato_cache,
  c.ultima_atividade,
  cl.nome AS cliente_nome,
  (
    SELECT m.texto
    FROM public.mensagens m
    WHERE m.company_id = 1
      AND m.conversa_id = c.id
    ORDER BY m.criado_em DESC, m.id DESC
    LIMIT 1
  ) AS ultima_texto,
  CASE
    WHEN lower(trim(coalesce(c.nome_contato_cache, ''))) IN ('contato', '(contato)')
      OR lower(trim(coalesce(cl.nome, ''))) IN ('contato', '(contato)')
      OR (
        (lower(coalesce(c.telefone, '')) LIKE 'lid:%' OR lower(coalesce(c.telefone, '')) LIKE '%@lid')
        AND coalesce(nullif(trim(cl.nome), ''), '') = ''
        AND coalesce(nullif(trim(cl.pushname), ''), '') = ''
        AND (
          c.nome_contato_cache IS NULL
          OR trim(c.nome_contato_cache) = ''
          OR lower(trim(c.nome_contato_cache)) IN ('contato', '(contato)')
        )
        AND (
          cl.telefone IS NULL
          OR trim(cl.telefone) = ''
          OR lower(cl.telefone) LIKE 'lid:%'
          OR lower(cl.telefone) LIKE '%@lid'
        )
      )
    THEN 'contato'
    WHEN (
      SELECT m.texto
      FROM public.mensagens m
      WHERE m.company_id = 1
        AND m.conversa_id = c.id
      ORDER BY m.criado_em DESC, m.id DESC
      LIMIT 1
    ) ILIKE '%Atendimento finalizado%'
    THEN 'finalizada_na_mensagem'
    ELSE 'outro'
  END AS motivo
FROM public.conversas c
LEFT JOIN public.clientes cl
  ON cl.id = c.cliente_id
 AND cl.company_id = c.company_id
WHERE c.company_id = 1
  AND lower(coalesce(c.tipo, '')) <> 'grupo'
  AND coalesce(c.telefone, '') NOT LIKE '%@g.us'
  AND c.status_atendimento IS DISTINCT FROM 'fechada'
  AND (
    lower(trim(coalesce(c.nome_contato_cache, ''))) IN ('contato', '(contato)')
    OR lower(trim(coalesce(cl.nome, ''))) IN ('contato', '(contato)')
    OR (
      (lower(coalesce(c.telefone, '')) LIKE 'lid:%' OR lower(coalesce(c.telefone, '')) LIKE '%@lid')
      AND coalesce(nullif(trim(cl.nome), ''), '') = ''
      AND coalesce(nullif(trim(cl.pushname), ''), '') = ''
      AND (
        c.nome_contato_cache IS NULL
        OR trim(c.nome_contato_cache) = ''
        OR lower(trim(c.nome_contato_cache)) IN ('contato', '(contato)')
      )
      AND (
        cl.telefone IS NULL
        OR trim(cl.telefone) = ''
        OR lower(cl.telefone) LIKE 'lid:%'
        OR lower(cl.telefone) LIKE '%@lid'
      )
    )
    OR (
      SELECT m.texto
      FROM public.mensagens m
      WHERE m.company_id = 1
        AND m.conversa_id = c.id
      ORDER BY m.criado_em DESC, m.id DESC
      LIMIT 1
    ) ILIKE '%Atendimento finalizado%'
  )
ORDER BY motivo, c.ultima_atividade DESC NULLS LAST;

-- ============================================================
-- FECHAR (rode só este bloco, sozinho)
-- ============================================================
DO $$
DECLARE
  v_company_id   int := 1;
  v_conversa_ids int[];
  v_afetadas     int;
BEGIN
  SELECT coalesce(array_agg(c.id), ARRAY[]::int[])
  INTO v_conversa_ids
  FROM public.conversas c
  LEFT JOIN public.clientes cl
    ON cl.id = c.cliente_id
   AND cl.company_id = c.company_id
  WHERE c.company_id = v_company_id
    AND lower(coalesce(c.tipo, '')) <> 'grupo'
    AND coalesce(c.telefone, '') NOT LIKE '%@g.us'
    AND c.status_atendimento IS DISTINCT FROM 'fechada'
    AND (
      lower(trim(coalesce(c.nome_contato_cache, ''))) IN ('contato', '(contato)')
      OR lower(trim(coalesce(cl.nome, ''))) IN ('contato', '(contato)')
      OR (
        (lower(coalesce(c.telefone, '')) LIKE 'lid:%' OR lower(coalesce(c.telefone, '')) LIKE '%@lid')
        AND coalesce(nullif(trim(cl.nome), ''), '') = ''
        AND coalesce(nullif(trim(cl.pushname), ''), '') = ''
        AND (
          c.nome_contato_cache IS NULL
          OR trim(c.nome_contato_cache) = ''
          OR lower(trim(c.nome_contato_cache)) IN ('contato', '(contato)')
        )
        AND (
          cl.telefone IS NULL
          OR trim(cl.telefone) = ''
          OR lower(cl.telefone) LIKE 'lid:%'
          OR lower(cl.telefone) LIKE '%@lid'
        )
      )
      OR (
        SELECT m.texto
        FROM public.mensagens m
        WHERE m.company_id = v_company_id
          AND m.conversa_id = c.id
        ORDER BY m.criado_em DESC, m.id DESC
        LIMIT 1
      ) ILIKE '%Atendimento finalizado%'
    );

  IF array_length(v_conversa_ids, 1) IS NULL THEN
    RAISE NOTICE 'Nada a fechar na company_id %.', v_company_id;
    RETURN;
  END IF;

  UPDATE public.conversas
  SET
    status_atendimento            = 'fechada',
    finalizacao_motivo            = NULL,
    finalizada_automaticamente    = false,
    finalizada_automaticamente_em = NULL,
    aguardando_cliente_desde      = NULL,
    ausencia_mensagem_enviada_em  = NULL,
    pagamento_prazo_ate           = NULL,
    pagamento_prazo_origem        = NULL,
    pagamento_concluido_em        = NULL,
    reaberta_falta_interacao_em   = NULL
  WHERE company_id = v_company_id
    AND id = ANY(v_conversa_ids);

  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  RAISE NOTICE 'Company %: conversas fechadas = %', v_company_id, v_afetadas;
END $$;
