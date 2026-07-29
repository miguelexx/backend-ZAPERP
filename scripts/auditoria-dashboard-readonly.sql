/*
  AUDITORIA DASHBOARD ZAPERP — SOMENTE LEITURA

  1. Substitua os quatro valores em params.
  2. Execute com um usuário que possua apenas SELECT.
  3. A consulta retorna um único JSON com contagens e amostras.
  4. include_legacy_null só deve ser true quando a empresa possui exatamente
     uma instância ativa e o legado anterior à migração já foi verificado.
*/
WITH
params AS (
  SELECT
    NULL::integer AS company_id,              -- ex.: 4
    NULL::bigint AS whatsapp_instance_id,     -- ex.: 8
    false::boolean AS include_legacy_null,
    '2026-07-23'::date AS data_inicio,
    '2026-07-29'::date AS data_fim
),
bounds AS (
  SELECT
    p.*,
    (p.data_inicio::timestamp AT TIME ZONE 'America/Sao_Paulo') AS from_ts,
    ((p.data_fim + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS to_ts_exclusive
  FROM params p
  WHERE p.company_id IS NOT NULL
    AND p.whatsapp_instance_id IS NOT NULL
),
mensagens_base AS (
  SELECT m.*
  FROM public.mensagens m
  CROSS JOIN bounds b
  WHERE m.company_id = b.company_id
    AND (
      m.whatsapp_instance_id = b.whatsapp_instance_id
      OR (b.include_legacy_null AND m.whatsapp_instance_id IS NULL)
    )
    AND m.criado_em >= b.from_ts
    AND m.criado_em < b.to_ts_exclusive
    AND m.direcao IN ('in', 'out')
    AND COALESCE(m.apagada_para_todos, false) = false
),
mensagens_dedup AS (
  SELECT *
  FROM (
    SELECT
      m.*,
      row_number() OVER (
        PARTITION BY
          CASE
            WHEN NULLIF(btrim(m.whatsapp_id), '') IS NOT NULL
              THEN concat('wa:', COALESCE(m.whatsapp_instance_id::text, 'legacy'), ':', m.whatsapp_id)
            ELSE concat('row:', m.id)
          END
        ORDER BY m.id
      ) AS dedupe_rn
    FROM mensagens_base m
  ) x
  WHERE x.dedupe_rn = 1
),
mensagens_classificadas AS (
  SELECT
    m.*,
    CASE
      WHEN lower(COALESCE(m.tipo, 'texto')) IN ('text', 'texto') THEN 'texto'
      WHEN lower(COALESCE(m.tipo, '')) IN ('audio', 'áudio', 'ptt', 'voice') THEN 'audio'
      WHEN lower(COALESCE(m.tipo, '')) IN ('image', 'imagem', 'photo') THEN 'imagem'
      WHEN lower(COALESCE(m.tipo, '')) IN ('video', 'vídeo') THEN 'video'
      WHEN lower(COALESCE(m.tipo, '')) IN ('document', 'documento', 'file', 'arquivo', 'pdf') THEN 'documento'
      ELSE 'outros'
    END AS tipo_normalizado,
    CASE
      WHEN m.direcao = 'in' THEN 'cliente'
      WHEN COALESCE(m.origem, '') IN ('sistema_humano', 'whatsapp_celular') THEN m.origem
      WHEN COALESCE(m.origem, '') IN ('automacao', 'bot', 'campanha', 'sistema') THEN m.origem
      WHEN m.autor_usuario_id IS NOT NULL THEN 'sistema_humano_legado'
      ELSE 'desconhecida'
    END AS origem_auditada
  FROM mensagens_dedup m
),
conversas_periodo AS (
  SELECT DISTINCT c.*
  FROM public.conversas c
  JOIN mensagens_classificadas m ON m.conversa_id = c.id
  CROSS JOIN bounds b
  WHERE c.company_id = b.company_id
    AND (
      c.whatsapp_instance_id = b.whatsapp_instance_id
      OR (b.include_legacy_null AND c.whatsapp_instance_id IS NULL)
    )
),
primeira_in AS (
  SELECT DISTINCT ON (m.conversa_id)
    m.conversa_id,
    m.id AS primeira_in_id,
    m.criado_em AS primeira_in_em
  FROM mensagens_classificadas m
  WHERE m.direcao = 'in'
  ORDER BY m.conversa_id, m.criado_em, m.id
),
primeira_resposta_humana AS (
  SELECT
    i.conversa_id,
    i.primeira_in_id,
    i.primeira_in_em,
    o.id AS primeira_out_id,
    o.criado_em AS primeira_out_em,
    o.origem_auditada,
    extract(epoch FROM (o.criado_em - i.primeira_in_em)) / 60.0 AS minutos
  FROM primeira_in i
  LEFT JOIN LATERAL (
    SELECT m.*
    FROM mensagens_classificadas m
    WHERE m.conversa_id = i.conversa_id
      AND m.direcao = 'out'
      AND m.criado_em >= i.primeira_in_em
      AND m.origem_auditada IN ('sistema_humano', 'whatsapp_celular', 'sistema_humano_legado')
    ORDER BY m.criado_em, m.id
    LIMIT 1
  ) o ON true
),
abertos_agora AS (
  SELECT count(*)::bigint AS total
  FROM public.conversas c
  CROSS JOIN bounds b
  WHERE c.company_id = b.company_id
    AND (
      c.whatsapp_instance_id = b.whatsapp_instance_id
      OR (b.include_legacy_null AND c.whatsapp_instance_id IS NULL)
    )
    AND c.status_atendimento IN ('aberta', 'em_atendimento', 'aguardando_cliente')
),
duplicidades AS (
  SELECT
    m.whatsapp_instance_id,
    m.whatsapp_id,
    count(*)::bigint AS total,
    array_agg(m.id ORDER BY m.id) AS ids
  FROM mensagens_base m
  WHERE NULLIF(btrim(m.whatsapp_id), '') IS NOT NULL
  GROUP BY m.whatsapp_instance_id, m.whatsapp_id
  HAVING count(*) > 1
),
resumo AS (
  SELECT jsonb_build_object(
    'periodo', (
      SELECT jsonb_build_object(
        'data_inicio', data_inicio,
        'data_fim', data_fim,
        'from_inclusive', from_ts,
        'to_exclusive', to_ts_exclusive,
        'timezone', 'America/Sao_Paulo'
      ) FROM bounds
    ),
    'mensagens', jsonb_build_object(
      'total', count(*),
      'recebidas', count(*) FILTER (WHERE m.direcao = 'in'),
      'enviadas', count(*) FILTER (WHERE m.direcao = 'out'),
      'por_tipo', (
        SELECT COALESCE(jsonb_object_agg(tipo_normalizado, total), '{}'::jsonb)
        FROM (
          SELECT tipo_normalizado, count(*) AS total
          FROM mensagens_classificadas
          GROUP BY tipo_normalizado
        ) t
      ),
      'por_origem', (
        SELECT COALESCE(jsonb_object_agg(origem_auditada, total), '{}'::jsonb)
        FROM (
          SELECT origem_auditada, count(*) AS total
          FROM mensagens_classificadas
          GROUP BY origem_auditada
        ) o
      )
    ),
    'conversas_com_atividade', (SELECT count(*) FROM conversas_periodo),
    'tickets_abertos_agora', (SELECT total FROM abertos_agora),
    'primeira_resposta', jsonb_build_object(
      'com_resposta_humana', (SELECT count(*) FROM primeira_resposta_humana WHERE primeira_out_id IS NOT NULL),
      'aguardando_resposta_humana', (SELECT count(*) FROM primeira_resposta_humana WHERE primeira_out_id IS NULL),
      'media_minutos', (SELECT round(avg(minutos)::numeric, 1) FROM primeira_resposta_humana WHERE minutos >= 0),
      'amostra', (
        SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
        FROM (
          SELECT conversa_id, primeira_in_id, primeira_in_em, primeira_out_id, primeira_out_em, origem_auditada, round(minutos::numeric, 1) AS minutos
          FROM primeira_resposta_humana
          ORDER BY primeira_in_em DESC
          LIMIT 20
        ) x
      )
    ),
    'duplicidades_provider_id', (
      SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb)
      FROM duplicidades d
    ),
    'legado_sem_instancia', count(*) FILTER (WHERE m.whatsapp_instance_id IS NULL)
  ) AS resultado
  FROM mensagens_classificadas m
)
SELECT resultado
FROM resumo;
