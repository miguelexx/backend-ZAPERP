-- =====================================================================================
-- DIAGNÓSTICO: passivo de mídia recebida SEM o `link` do provedor (Whapi/UltraMsg)
-- =====================================================================================
-- Contexto (auditoria 15/10/2026):
--   A setting `media.auto_download` do canal Whapi só entrega o campo `link` no webhook para os
--   tipos incluídos nela. Sem `link`:
--     • foto / vídeo / documento SEM legenda  → o webhook montava texto '(mídia)' e a guarda
--       `soPlaceholderMidia` (controllers/webhookZapiController.js) DESCARTAVA o evento:
--       NÃO existe linha em `mensagens`; só `conversas.ultima_atividade` subiu.
--     • foto / vídeo / documento COM legenda  → gravou linha com tipo='texto', url NULL e a
--       legenda no texto (nenhum rastro de que era mídia).
--     • áudio / figurinha                     → gravou linha com tipo='audio'/'voice' e url NULL.
--   As correções de código (não deployadas em 15/10) valem só para o que chegar daqui pra frente:
--   agora a linha nasce com texto '(imagem)' / '(vídeo)' / '(arquivo)' e é reparável. Este script
--   mede o PASSIVO — o que já está quebrado no banco.
--
-- NATUREZA: 100% SOMENTE LEITURA. Nenhum UPDATE/DELETE/INSERT/DDL. Seguro em produção.
-- ONDE RODAR: Supabase SQL Editor (uma consulta por vez — selecione o bloco e execute).
--
-- COMO USAR: cada consulta começa com um CTE `p`. Edite SÓ a linha marcada `<< EDITE`:
--     empresas     → array de company_id (isolamento app-layer: o filtro é sempre explícito)
--     janela_dias  → 45 = janela real do histórico Whapi (`GET /messages/list`, CONTACT_HISTORY_
--                    WINDOW_DAYS em services/oldMessagesSyncService.js). Fora dela, não há o que
--                    buscar no provedor: a mídia está perdida de vez.
--
-- CUIDADO COM FUSO (não "simplifique" os casts):
--   `mensagens.criado_em`        = timestamp WITHOUT time zone, gravado em UTC (toISOString()).
--   `conversas.ultima_atividade` = timestamp WITH time zone.
--   Comparar os dois sem `AT TIME ZONE 'UTC'` desloca 3h e enche a consulta 8 de falso positivo.
--
-- "URL utilizável" espelha `temUrlUtilizavel()` do oldMessagesSyncService: https://, http://,
--   /uploads/ (cópia na VPS) ou /media/r2/ (espelho R2). Qualquer outra coisa = bolha quebrada.
--
-- Se alguma consulta reclamar de coluna inexistente (`apagada_para_todos`, `storage_backend`,
--   `midia_persist_status`), a migration correspondente não foi aplicada nesse banco: remova a
--   linha citada e rode de novo.
--
-- DESEMPENHO: não existe índice por `tipo`/`url`, então as consultas 2–4 varrem `mensagens`. Se o
--   SQL Editor estourar o tempo limite, reduza `janela_dias` / `dias_historico` e rode por empresa.
-- =====================================================================================


-- =====================================================================================
-- 1) CONTEXTO — quais empresas/instâncias são Whapi (as únicas afetadas pelo auto_download)
-- Esperado: ver provider='whapi' nas empresas que você vai diagnosticar. Se a empresa só tem
-- instância 'ultramsg', o estrago aqui tem outra causa (webhook_message_download_media ineficaz).
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas)  -- << EDITE
SELECT
  i.company_id,
  e.nome                AS empresa,
  i.id                  AS whatsapp_instance_id,
  i.provider,
  i.nome                AS instancia,
  i.ativo,
  i.is_default,
  i.status,
  i.display_phone
FROM public.whatsapp_instances i
JOIN public.empresas e ON e.id = i.company_id
WHERE i.company_id IN (SELECT unnest(empresas) FROM p)
ORDER BY i.company_id, i.is_default DESC, i.id;


-- =====================================================================================
-- 2) PANORAMA — linhas de MÍDIA (tipo de mídia) sem URL utilizável, por empresa/tipo/direção
-- Esperado: o volume do estrago reparável. `dentro_janela` é o que o provedor ainda pode devolver;
-- `fora_janela` é perda definitiva. `sem_whatsapp_id` NÃO é reparável nem dentro da janela — o
-- reparo casa a linha do histórico por `whatsapp_id`.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias)  -- << EDITE
SELECT
  m.company_id,
  m.tipo,
  m.direcao,
  count(*)                                                                      AS linhas,
  count(*) FILTER (WHERE (m.criado_em AT TIME ZONE 'UTC')
                         >= now() - make_interval(days => (SELECT janela_dias FROM p))) AS dentro_janela,
  count(*) FILTER (WHERE (m.criado_em AT TIME ZONE 'UTC')
                         <  now() - make_interval(days => (SELECT janela_dias FROM p))) AS fora_janela,
  count(*) FILTER (WHERE m.whatsapp_id IS NULL OR btrim(m.whatsapp_id) = '')     AS sem_whatsapp_id,
  count(DISTINCT m.conversa_id)                                                  AS conversas,
  min(m.criado_em)                                                               AS mais_antiga_utc,
  max(m.criado_em)                                                               AS mais_recente_utc
FROM public.mensagens m
WHERE m.company_id IN (SELECT unnest(empresas) FROM p)
  AND m.tipo IN ('imagem', 'video', 'audio', 'voice', 'sticker', 'arquivo', 'documento')
  AND COALESCE(m.url, '') NOT LIKE 'https://%'
  AND COALESCE(m.url, '') NOT LIKE 'http://%'
  AND COALESCE(m.url, '') NOT LIKE '/uploads/%'
  AND COALESCE(m.url, '') NOT LIKE '/media/r2/%'
  AND NOT COALESCE(m.apagada_para_todos, false)
  AND NOT COALESCE(m.apagada_pelo_cliente, false)
GROUP BY m.company_id, m.tipo, m.direcao
ORDER BY m.company_id, linhas DESC;


-- =====================================================================================
-- 3) PANORAMA — linhas com TEXTO DE PLACEHOLDER e sem URL utilizável
-- Pega o que a consulta 2 não vê: foto/vídeo/documento que ficaram com tipo='texto' (default),
-- e também as linhas novas pós-correção ('(imagem)', '(vídeo)', '(arquivo)').
-- Esperado: '(áudio)' e '(mensagem)' em volume (passivo antigo); '(imagem)'/'(vídeo)'/'(arquivo)'
-- em tipo='texto' só aparecem DEPOIS do deploy da correção.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias)  -- << EDITE
SELECT
  m.company_id,
  lower(btrim(m.texto)) AS texto_placeholder,
  m.tipo,
  m.direcao,
  count(*)                                                                      AS linhas,
  count(*) FILTER (WHERE (m.criado_em AT TIME ZONE 'UTC')
                         >= now() - make_interval(days => (SELECT janela_dias FROM p))) AS dentro_janela,
  count(*) FILTER (WHERE m.whatsapp_id IS NULL OR btrim(m.whatsapp_id) = '')     AS sem_whatsapp_id,
  count(DISTINCT m.conversa_id)                                                  AS conversas,
  max(m.criado_em)                                                               AS mais_recente_utc
FROM public.mensagens m
WHERE m.company_id IN (SELECT unnest(empresas) FROM p)
  AND lower(btrim(m.texto)) IN (
    '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
    '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)',
    '(arquivo)', '(documento)'
  )
  AND COALESCE(m.url, '') NOT LIKE 'https://%'
  AND COALESCE(m.url, '') NOT LIKE 'http://%'
  AND COALESCE(m.url, '') NOT LIKE '/uploads/%'
  AND COALESCE(m.url, '') NOT LIKE '/media/r2/%'
  AND NOT COALESCE(m.apagada_para_todos, false)
  AND NOT COALESCE(m.apagada_pelo_cliente, false)
GROUP BY m.company_id, lower(btrim(m.texto)), m.tipo, m.direcao
ORDER BY m.company_id, linhas DESC;


-- =====================================================================================
-- 4) LINHA DO TEMPO — por dia (fuso América/São_Paulo), últimos 60 dias
-- Responde "explodiu em 15/10/2026 ou é antigo?". Dia com salto = mudança de configuração do
-- canal (auto_download) naquele dia; platô constante = problema estrutural antigo.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 60 AS dias_historico)  -- << EDITE
SELECT
  m.company_id,
  date((m.criado_em AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo') AS dia_sp,
  count(*)                                                                 AS linhas_sem_midia,
  count(*) FILTER (WHERE m.tipo IN ('audio', 'voice'))                     AS audio,
  count(*) FILTER (WHERE m.tipo IN ('imagem', 'video', 'sticker'))          AS imagem_video,
  count(*) FILTER (WHERE m.tipo IN ('arquivo', 'documento'))                AS documento,
  count(*) FILTER (WHERE m.tipo = 'texto')                                  AS tipo_texto_placeholder,
  count(DISTINCT m.conversa_id)                                             AS conversas
FROM public.mensagens m
WHERE m.company_id IN (SELECT unnest(empresas) FROM p)
  AND (m.criado_em AT TIME ZONE 'UTC') >= now() - make_interval(days => (SELECT dias_historico FROM p))
  AND (
    m.tipo IN ('imagem', 'video', 'audio', 'voice', 'sticker', 'arquivo', 'documento')
    OR lower(btrim(m.texto)) IN (
      '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
      '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)',
      '(arquivo)', '(documento)'
    )
  )
  AND COALESCE(m.url, '') NOT LIKE 'https://%'
  AND COALESCE(m.url, '') NOT LIKE 'http://%'
  AND COALESCE(m.url, '') NOT LIKE '/uploads/%'
  AND COALESCE(m.url, '') NOT LIKE '/media/r2/%'
  AND NOT COALESCE(m.apagada_para_todos, false)
  AND NOT COALESCE(m.apagada_pelo_cliente, false)
GROUP BY m.company_id, dia_sp
ORDER BY m.company_id, dia_sp DESC;


-- =====================================================================================
-- 5) LISTA DE TRABALHO — por conversa (é o insumo do reparo em massa)
-- Esperado: ranking das conversas com mais linhas quebradas DENTRO da janela. `reparaveis` =
-- linhas com whatsapp_id dentro da janela (as que o histórico do provedor pode casar).
-- O script backend/scripts/reparar-midia-sem-link.js monta esta mesma lista sozinho; esta
-- consulta serve para conferir o número antes e depois.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias),  -- << EDITE
afetadas AS (
  SELECT
    m.company_id,
    m.conversa_id,
    m.id,
    m.tipo,
    m.whatsapp_id,
    m.criado_em,
    ((m.criado_em AT TIME ZONE 'UTC') >= now() - make_interval(days => (SELECT janela_dias FROM p))) AS dentro_janela
  FROM public.mensagens m
  WHERE m.company_id IN (SELECT unnest(empresas) FROM p)
    AND (
      m.tipo IN ('imagem', 'video', 'audio', 'voice', 'sticker', 'arquivo', 'documento')
      OR lower(btrim(m.texto)) IN (
        '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
        '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)',
        '(arquivo)', '(documento)'
      )
    )
    AND COALESCE(m.url, '') NOT LIKE 'https://%'
    AND COALESCE(m.url, '') NOT LIKE 'http://%'
    AND COALESCE(m.url, '') NOT LIKE '/uploads/%'
    AND COALESCE(m.url, '') NOT LIKE '/media/r2/%'
    AND NOT COALESCE(m.apagada_para_todos, false)
    AND NOT COALESCE(m.apagada_pelo_cliente, false)
)
SELECT
  a.company_id,
  a.conversa_id,
  c.telefone,
  COALESCE(c.nome_grupo, c.nome_contato_cache, cl.nome) AS contato,
  c.tipo                                               AS conversa_tipo,
  i.provider,
  count(*)                                             AS linhas_quebradas,
  count(*) FILTER (WHERE a.dentro_janela)               AS dentro_janela,
  count(*) FILTER (WHERE a.dentro_janela
                     AND a.whatsapp_id IS NOT NULL
                     AND btrim(a.whatsapp_id) <> '')    AS reparaveis,
  min(a.criado_em)                                      AS mais_antiga_utc,
  max(a.criado_em)                                      AS mais_recente_utc
FROM afetadas a
JOIN public.conversas c       ON c.id = a.conversa_id AND c.company_id = a.company_id
LEFT JOIN public.clientes cl  ON cl.id = c.cliente_id AND cl.company_id = a.company_id
LEFT JOIN public.whatsapp_instances i ON i.id = c.whatsapp_instance_id AND i.company_id = a.company_id
GROUP BY a.company_id, a.conversa_id, c.telefone, c.nome_grupo, c.nome_contato_cache, cl.nome, c.tipo, i.provider
ORDER BY reparaveis DESC, linhas_quebradas DESC
LIMIT 200;


-- =====================================================================================
-- 6) DETALHE — as linhas, para olho humano (amostra)
-- Esperado: confirmar o padrão (texto placeholder, url NULL, whatsapp_id presente).
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias)  -- << EDITE
SELECT
  m.id,
  m.company_id,
  m.conversa_id,
  m.direcao,
  m.tipo,
  left(COALESCE(m.texto, ''), 60) AS texto,
  m.url,
  m.nome_arquivo,
  m.whatsapp_id,
  m.midia_persist_status,
  m.midia_persist_erro_tipo,
  m.criado_em                     AS criado_em_utc
FROM public.mensagens m
WHERE m.company_id IN (SELECT unnest(empresas) FROM p)
  AND (m.criado_em AT TIME ZONE 'UTC') >= now() - make_interval(days => (SELECT janela_dias FROM p))
  AND (
    m.tipo IN ('imagem', 'video', 'audio', 'voice', 'sticker', 'arquivo', 'documento')
    OR lower(btrim(m.texto)) IN (
      '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
      '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)',
      '(arquivo)', '(documento)'
    )
  )
  AND COALESCE(m.url, '') NOT LIKE 'https://%'
  AND COALESCE(m.url, '') NOT LIKE 'http://%'
  AND COALESCE(m.url, '') NOT LIKE '/uploads/%'
  AND COALESCE(m.url, '') NOT LIKE '/media/r2/%'
  AND NOT COALESCE(m.apagada_para_todos, false)
  AND NOT COALESCE(m.apagada_pelo_cliente, false)
ORDER BY m.criado_em DESC
LIMIT 200;


-- =====================================================================================
-- 7) SEPARAR AS DUAS DOENÇAS — "nunca teve link" × "link chegou e a cópia falhou"
-- Esperado:
--   midia_persist_status NULL          → nunca houve URL para copiar (é o caso deste diagnóstico)
--   'pendente' / 'falha_definitiva'    → a URL existiu e o download falhou/expirou (outro problema,
--                                        tratado por inboundMediaPersistenceService / reprocessar-midia)
-- Se quase tudo vier NULL, o passivo é mesmo de `link` ausente.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias)  -- << EDITE
SELECT
  m.company_id,
  COALESCE(m.midia_persist_status, '(nunca tentado)') AS midia_persist_status,
  COALESCE(m.midia_persist_erro_tipo, '-')            AS erro_tipo,
  count(*)                                            AS linhas,
  count(*) FILTER (WHERE m.midia_persist_tentativas > 0) AS com_tentativa,
  left(COALESCE(max(m.midia_persist_erro), ''), 80)   AS exemplo_erro
FROM public.mensagens m
WHERE m.company_id IN (SELECT unnest(empresas) FROM p)
  AND (m.criado_em AT TIME ZONE 'UTC') >= now() - make_interval(days => (SELECT janela_dias FROM p))
  AND m.tipo IN ('imagem', 'video', 'audio', 'voice', 'sticker', 'arquivo', 'documento')
  AND COALESCE(m.url, '') NOT LIKE 'https://%'
  AND COALESCE(m.url, '') NOT LIKE 'http://%'
  AND COALESCE(m.url, '') NOT LIKE '/uploads/%'
  AND COALESCE(m.url, '') NOT LIKE '/media/r2/%'
GROUP BY m.company_id, m.midia_persist_status, m.midia_persist_erro_tipo
ORDER BY m.company_id, linhas DESC;


-- =====================================================================================
-- 8) LACUNA — conversas que receberam algo que NÃO virou linha (foto/vídeo/doc descartados)
-- Como funciona: a guarda `soPlaceholderMidia` atualizava `conversas.ultima_atividade` e seguia
-- sem inserir. Então uma conversa cuja `ultima_atividade` é bem mais nova que a última mensagem
-- gravada denuncia um evento perdido.
--
-- FALSOS POSITIVOS ESPERADOS (ultima_atividade também sobe nesses casos):
--   • ACK/status de mensagem antiga, reação, edição, enquete, evento ignorado por outra guarda;
--   • mensagem apagada depois (a linha some, a atividade fica);
--   • import de histórico já rodado (updateConversationActivity avança a atividade).
-- Portanto: é PISTA, não prova. Use `lacuna_min` alto (>= 120s) e confirme na consulta 9 / no chat.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias, 120 AS lacuna_min_seg),  -- << EDITE
ult AS (
  SELECT
    c.id        AS conversa_id,
    c.company_id,
    c.telefone,
    COALESCE(c.nome_grupo, c.nome_contato_cache) AS contato,
    c.ultima_atividade,
    (SELECT max(m.criado_em) AT TIME ZONE 'UTC'
       FROM public.mensagens m
      WHERE m.company_id = c.company_id
        AND m.conversa_id = c.id) AS ultima_mensagem
  FROM public.conversas c
  WHERE c.company_id IN (SELECT unnest(empresas) FROM p)
    AND c.ultima_atividade >= now() - make_interval(days => (SELECT janela_dias FROM p))
)
SELECT
  u.company_id,
  u.conversa_id,
  u.telefone,
  u.contato,
  u.ultima_atividade,
  u.ultima_mensagem,
  round(extract(epoch FROM (u.ultima_atividade - u.ultima_mensagem)))        AS lacuna_seg,
  date(u.ultima_atividade AT TIME ZONE 'America/Sao_Paulo')                  AS dia_sp
FROM ult u
WHERE u.ultima_mensagem IS NOT NULL
  AND u.ultima_atividade - u.ultima_mensagem
      > make_interval(secs => (SELECT lacuna_min_seg FROM p))
ORDER BY lacuna_seg DESC
LIMIT 200;


-- =====================================================================================
-- 8b) LACUNA — a mesma coisa resumida por dia (para cruzar com a consulta 4)
-- Esperado: se o pico de lacunas cai no mesmo dia do pico da consulta 4, é a mesma causa.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias, 120 AS lacuna_min_seg),  -- << EDITE
ult AS (
  SELECT
    c.company_id,
    c.ultima_atividade,
    (SELECT max(m.criado_em) AT TIME ZONE 'UTC'
       FROM public.mensagens m
      WHERE m.company_id = c.company_id
        AND m.conversa_id = c.id) AS ultima_mensagem
  FROM public.conversas c
  WHERE c.company_id IN (SELECT unnest(empresas) FROM p)
    AND c.ultima_atividade >= now() - make_interval(days => (SELECT janela_dias FROM p))
)
SELECT
  company_id,
  date(ultima_atividade AT TIME ZONE 'America/Sao_Paulo') AS dia_sp,
  count(*)                                                AS conversas_com_lacuna
FROM ult
WHERE ultima_mensagem IS NOT NULL
  AND ultima_atividade - ultima_mensagem
      > make_interval(secs => (SELECT lacuna_min_seg FROM p))
GROUP BY company_id, dia_sp
ORDER BY company_id, dia_sp DESC;


-- =====================================================================================
-- 9) RASTRO FORENSE — webhook_logs tem como provar o que foi descartado?
-- `webhook_logs.payload` guarda o corpo COMPLETO só quando WEBHOOK_LOG_FULL_PAYLOAD=1 no .env;
-- no modo padrão guarda um resumo (compactWebhookPayload) que, para Whapi, não traz o id da
-- mensagem nem o tipo — ou seja, não identifica a mídia perdida.
-- Esperado: se `tem_messages_array` = 0 em tudo, o log está no modo compacto e NÃO dá para
-- recuperar id/tipo das mídias descartadas por aqui.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 10 AS dias_historico)  -- << EDITE
SELECT
  w.company_id,
  date(w.criado_em AT TIME ZONE 'America/Sao_Paulo')                       AS dia_sp,
  w.provider,
  w.status,
  count(*)                                                                 AS entregas,
  count(*) FILTER (WHERE w.payload ? 'messages')                           AS tem_messages_array,
  count(*) FILTER (WHERE (w.payload -> '_log') IS NOT NULL)                AS tem_log_compacto,
  count(*) FILTER (WHERE (w.payload ->> 'has_media') = 'true')             AS resumo_com_midia
FROM public.webhook_logs w
WHERE w.company_id IN (SELECT unnest(empresas) FROM p)
  AND w.criado_em >= now() - make_interval(days => (SELECT dias_historico FROM p))
GROUP BY w.company_id, dia_sp, w.provider, w.status
ORDER BY w.company_id, dia_sp DESC, entregas DESC;


-- =====================================================================================
-- 9b) RASTRO FORENSE (só se WEBHOOK_LOG_FULL_PAYLOAD=1 estava ligado)
-- Aí sim: lista os eventos de mídia que chegaram SEM `link` — prova direta do descarte.
-- Esperado: vazio no modo compacto (que é o padrão).
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 10 AS dias_historico)  -- << EDITE
SELECT
  w.id,
  w.company_id,
  w.criado_em,
  msg ->> 'id'                       AS whatsapp_id,
  msg ->> 'type'                     AS tipo_provedor,
  msg ->> 'chat_id'                  AS chat_id,
  (msg ->> 'from_me')                AS from_me,
  (msg -> (msg ->> 'type')) ? 'link' AS tem_link
FROM public.webhook_logs w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.payload -> 'messages', '[]'::jsonb)) AS msg
WHERE w.company_id IN (SELECT unnest(empresas) FROM p)
  AND w.provider = 'whapi'
  AND w.criado_em >= now() - make_interval(days => (SELECT dias_historico FROM p))
  AND (msg ->> 'type') IN ('image', 'video', 'document', 'audio', 'voice', 'sticker')
  AND NOT COALESCE((msg -> (msg ->> 'type')) ? 'link', false)
ORDER BY w.criado_em DESC
LIMIT 200;


-- =====================================================================================
-- 10) VEREDITO — uma linha por empresa: quanto dá para reparar e quanto se perdeu
-- Esperado: é o número que decide se vale rodar o reparo em massa.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas, 45 AS janela_dias),  -- << EDITE
afetadas AS (
  SELECT
    m.company_id,
    m.conversa_id,
    m.whatsapp_id,
    ((m.criado_em AT TIME ZONE 'UTC') >= now() - make_interval(days => (SELECT janela_dias FROM p))) AS dentro_janela
  FROM public.mensagens m
  WHERE m.company_id IN (SELECT unnest(empresas) FROM p)
    AND (
      m.tipo IN ('imagem', 'video', 'audio', 'voice', 'sticker', 'arquivo', 'documento')
      OR lower(btrim(m.texto)) IN (
        '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
        '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)',
        '(arquivo)', '(documento)'
      )
    )
    AND COALESCE(m.url, '') NOT LIKE 'https://%'
    AND COALESCE(m.url, '') NOT LIKE 'http://%'
    AND COALESCE(m.url, '') NOT LIKE '/uploads/%'
    AND COALESCE(m.url, '') NOT LIKE '/media/r2/%'
    AND NOT COALESCE(m.apagada_para_todos, false)
    AND NOT COALESCE(m.apagada_pelo_cliente, false)
)
SELECT
  company_id,
  count(*)                                                                   AS linhas_quebradas,
  count(*) FILTER (WHERE dentro_janela
                     AND whatsapp_id IS NOT NULL
                     AND btrim(whatsapp_id) <> '')                           AS reparaveis,
  count(*) FILTER (WHERE NOT dentro_janela)                                  AS perdidas_fora_janela,
  count(*) FILTER (WHERE dentro_janela
                     AND (whatsapp_id IS NULL OR btrim(whatsapp_id) = ''))   AS perdidas_sem_whatsapp_id,
  count(DISTINCT conversa_id) FILTER (WHERE dentro_janela)                   AS conversas_a_reparar
FROM afetadas
GROUP BY company_id
ORDER BY company_id;
